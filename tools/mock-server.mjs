// Faux serveur NovAccès pour tester l'app agent de bout en bout, sans toucher
// à la production. Il implémente le contrat tel que décrit par
// GET /swagger/v1/swagger.json et la réponse backend du 05/08/2026, y compris
// les règles qui piègent : X-Api-Key exigée sur chaque requête même en présence
// d'un Bearer, enveloppes signées custom (pas du JWS), signedList sérialisé en
// chaîne, et 409 porteur du même corps que 200 sur /api/scan/sync.
//
//   node tools/mock-server.mjs
//
// Ouvrez ensuite http://<ip-affichée>:4000/ sur un écran : la page présente le
// QR d'enrôlement et un QR par scénario de test, à scanner depuis le téléphone.
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const PORT = Number(process.env.PORT ?? 4000);
const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = join(HERE, '.mock-keys.json');
const MIN = 60_000;

// ---------------------------------------------------------------- clés ES256
// Persistées : sans cela, chaque redémarrage invaliderait les QR déjà imprimés
// et l'enrôlement déjà réalisé sur le téléphone.
function loadKeys() {
  if (existsSync(KEY_FILE)) {
    const saved = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    return {
      privateKey: crypto.createPrivateKey(saved.privatePem),
      publicPem: saved.publicPem,
    };
  }
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(KEY_FILE, JSON.stringify({ privatePem, publicPem }, null, 2));
  return { privateKey: pair.privateKey, publicPem };
}
const KEYS = loadKeys();
const KID = 'current';

// Signature ES256 au format IEEE P1363, comme .NET ECDsa.SignData. Aucune
// normalisation low-S : c'est justement ce que l'app doit savoir accepter.
function signEnvelope(payloadObject) {
  const payloadBytes = Buffer.from(JSON.stringify(payloadObject), 'utf8');
  const signature = crypto.sign('sha256', payloadBytes, {
    key: KEYS.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return JSON.stringify({
    PayloadB64Url: payloadBytes.toString('base64url'),
    SignatureB64Url: signature.toString('base64url'),
    KeyId: KID,
  });
}

// ------------------------------------------------------------------- données
const SITE_ID = 'SITE-TEST';
const AGENT = { matricule: 'AG-001', pin: '1234', displayName: 'Agent de test' };
const at = (deltaMin) => Date.now() + deltaMin * MIN;

// Chaque scénario vise un verdictCode précis de l'énumération Q4.
const SCENARIOS = [
  { key: 'granted', nom: 'Awa Traoré', mode: 'unique', attendu: 'GRANTED',
    debut: at(-10), fin: at(50), note: 'Entrée nominale, dans la fenêtre.' },
  { key: 'granted30j', nom: 'Moussa Camara', mode: '30j', attendu: 'GRANTED',
    debut: at(-120), fin: at(600), note: 'Accès 30 jours ouvrés.' },
  { key: 'tooEarly', nom: 'Fatou Diallo', mode: 'unique', attendu: 'DENIED_TooEarly',
    debut: at(90), fin: at(150), note: 'Présenté avant l’ouverture de la fenêtre.' },
  { key: 'tooLate', nom: 'Ibrahim Koné', mode: 'unique', attendu: 'DENIED_TooLate',
    debut: at(-300), fin: at(-120), note: 'Fenêtre close depuis 2 h.' },
  { key: 'revoked', nom: 'Salif Bamba', mode: 'unique', attendu: 'DENIED_Revoked',
    debut: at(-10), fin: at(60), statut: 'révoqué', note: 'QR révoqué par la sûreté.' },
  { key: 'excluded', nom: 'Karim Sow', mode: 'unique', attendu: 'DENIED_Excluded',
    debut: at(-10), fin: at(60), exclu: true, note: 'Visiteur sur liste d’exclusion.' },
  { key: 'onSite', nom: 'Aminata Cissé', mode: 'unique', attendu: 'DENIED_SuspectedDuplicate',
    debut: at(-60), fin: at(60), present: true, entreeAt: at(-45),
    note: 'Déjà sur site : au poste ENTRÉE = suspicion de copie. Au poste SORTIE = CHECKED_OUT.' },
  { key: 'consumed', nom: 'Yao Kouassi', mode: 'unique', attendu: 'DENIED_AlreadyConsumed',
    debut: at(-90), fin: at(60), statut: 'sorti', note: 'QR à passage unique déjà consommé.' },
  { key: 'expired', nom: 'Nadia Bensalem', mode: 'unique', attendu: 'INVALID_SIGNATURE',
    debut: at(-10), fin: at(60), expSeconds: Math.floor((Date.now() - 3600_000) / 1000),
    note: 'Claim Exp dans le passé : refusé même hors ligne.' },
  { key: 'notInList', nom: 'Visiteur hors liste', mode: 'unique', attendu: 'DENIED_NotInOfflineList',
    debut: at(-10), fin: at(60), horsListe: true,
    note: 'Signature valide mais absent de la liste du jour : refus hors ligne, contrôle serveur en ligne.' },
];

const visits = new Map();
for (const s of SCENARIOS) {
  visits.set(s.key, {
    ...s,
    visitId: crypto.randomUUID(),
    visitToken: crypto.randomUUID(),
    statut: s.statut ?? 'attendu',
    present: s.present ?? false,
    exclu: s.exclu ?? false,
    exited: s.statut === 'sorti',
  });
}

const terminals = new Map(); // apiKey -> terminal
const shifts = new Map(); // shiftToken -> matricule
const tickets = new Map(); // ticket -> { used }
const ENROLL_TICKET = crypto.randomBytes(32).toString('base64url');
tickets.set(ENROLL_TICKET, { used: false });

let offline = false; // bascule pour éprouver le mode dégradé
const syncedScans = [];

// ------------------------------------------------------------------- helpers
function qrFor(visit) {
  return signEnvelope({
    VisitId: visit.visitId,
    VisitToken: visit.visitToken,
    Exp: visit.expSeconds ?? Math.floor((Date.now() + 12 * 3600_000) / 1000),
  });
}

// QR authentique dont le payload a été altéré après signature.
function forgedQr() {
  const real = JSON.parse(qrFor(visits.get('granted')));
  real.PayloadB64Url = Buffer.from(
    JSON.stringify({ VisitId: crypto.randomUUID(), VisitToken: crypto.randomUUID(), Exp: 9e9 }),
    'utf8',
  ).toString('base64url');
  return JSON.stringify(real);
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const HOST = lanAddress();
const BASE_URL = `http://${HOST}:${PORT}`;

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

// La policy AgentTerminal : X-Api-Key sur CHAQUE requête, le Bearer ne la
// remplace jamais. C'est le piège que l'app doit passer.
function requireTerminal(req, res) {
  const key = req.headers['x-api-key'];
  if (!key || !terminals.has(key)) {
    send(res, 401, { error: 'X-Api-Key absente ou inconnue.' });
    return null;
  }
  return terminals.get(key);
}

function bearerShift(req) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token && shifts.has(token) ? { token, matricule: shifts.get(token) } : null;
}

function decideScan(visit, direction) {
  if (!visit) return { isGranted: false, isCheckOut: false, isSecurityEvent: true, verdictCode: 'INVALID_SIGNATURE', visitorName: null };
  const name = visit.nom;
  if (direction === 'Exit') {
    if (!visit.present) return { isGranted: false, isCheckOut: false, isSecurityEvent: false, verdictCode: 'DENIED_NoActiveEntry', visitorName: name };
    visit.present = false;
    visit.exited = true;
    return { isGranted: false, isCheckOut: true, isSecurityEvent: false, verdictCode: 'CHECKED_OUT', visitorName: name, presenceMinutes: 45, overstayMinutes: 0 };
  }
  const deny = (code, sec = true) => ({ isGranted: false, isCheckOut: false, isSecurityEvent: sec, verdictCode: code, visitorName: name });
  if (visit.exclu) return deny('DENIED_Excluded');
  if (visit.present) return deny('DENIED_SuspectedDuplicate');
  if (visit.statut === 'révoqué') return deny('DENIED_Revoked');
  if (visit.mode === 'unique' && visit.exited) return deny('DENIED_CycleAlreadyClosed');
  if (visit.statut === 'sorti') return deny('DENIED_AlreadyConsumed');
  if (Date.now() < visit.debut) return deny('DENIED_TooEarly');
  if (Date.now() > visit.fin) return deny('DENIED_TooLate');
  visit.present = true;
  visit.entreeAt = Date.now();
  if (visit.mode === 'unique') visit.statut = 'sur site';
  return { isGranted: true, isCheckOut: false, isSecurityEvent: false, verdictCode: 'GRANTED', visitorName: name };
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

// -------------------------------------------------------------------- routes
const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const path = url.pathname;
  const method = req.method;
  const log = (msg) => console.log(`  ${method} ${path} — ${msg}`);

  if (method === 'OPTIONS') return send(res, 204, '');

  // Bascule hors ligne : tout tombe en panne réseau sauf la page d'accueil.
  if (path === '/__mock/offline' || path === '/__mock/online') {
    offline = path.endsWith('offline');
    console.log(`\n>>> serveur ${offline ? 'INJOIGNABLE (mode dégradé)' : 'de nouveau joignable'}\n`);
    return send(res, 200, { offline });
  }
  if (offline && path.startsWith('/api')) {
    req.destroy(); // coupure franche : l'app doit lever NetworkError
    return;
  }

  if (path === '/' || path === '/index.html') return send(res, 200, await page(), 'text/html; charset=utf-8');
  if (path === '/api/health') return send(res, 200, { status: 'ok', serverTimeUtc: new Date().toISOString() });
  if (path === '/api/keys/public') {
    return send(res, 200, { kid: KID, publicKeyPem: KEYS.publicPem, retiredKeys: [] });
  }

  if (path === '/api/device-enrollments/activate' && method === 'POST') {
    const body = (await readBody(req)) ?? {};
    const ticket = tickets.get(body.ticket);
    if (!ticket) return send(res, 410, { error: "Ticket d'enrôlement inconnu." });
    if (ticket.used) return send(res, 410, { error: "Ticket d'enrôlement déjà utilisé." });

    // Vérification identique à DeviceEnrollmentEndpoints.cs : message
    // "{ticket}|{deviceInstanceId}", signature P1363, encodage Base64URL.
    let valid = false;
    try {
      valid = crypto.verify(
        'sha256',
        Buffer.from(`${body.ticket}|${body.deviceInstanceId}`, 'utf8'),
        { key: crypto.createPublicKey(body.devicePublicKeyPem), dsaEncoding: 'ieee-p1363' },
        Buffer.from(body.proofSignature ?? '', 'base64url'),
      );
    } catch (err) {
      log(`clé publique illisible : ${err.message}`);
    }
    if (!valid) {
      log('PREUVE REJETÉE — message, encodage ou format de signature incorrect');
      return send(res, 400, { error: 'proofSignature invalide.' });
    }

    ticket.used = true;
    const apiKey = crypto.randomBytes(24).toString('base64url');
    terminals.set(apiKey, { terminalId: crypto.randomUUID(), label: 'Terminal de test', siteIds: [SITE_ID] });
    log('preuve de possession VALIDE, terminal enrôlé');
    return send(res, 200, {
      ...terminals.get(apiKey),
      apiKey,
      enrolledAt: new Date().toISOString(),
    });
  }

  // Tout ce qui suit exige la clé de terminal.
  if (!path.startsWith('/api')) return send(res, 404, { error: 'Route inconnue.' });
  const terminal = requireTerminal(req, res);
  if (!terminal) return log('refusé : X-Api-Key manquante');

  if (path === '/api/agent/shift/start' && method === 'POST') {
    const body = (await readBody(req)) ?? {};
    if (body.matricule !== AGENT.matricule || body.pin !== AGENT.pin) {
      log('identifiants agent refusés');
      return send(res, 401, { error: 'Matricule ou code PIN incorrect.' });
    }
    const shiftToken = crypto.randomBytes(24).toString('base64url');
    shifts.set(shiftToken, body.matricule);
    log(`poste ouvert par ${body.matricule}`);
    return send(res, 200, {
      matricule: AGENT.matricule,
      displayName: AGENT.displayName,
      shiftToken,
      expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    });
  }

  if (path === '/api/agent/shift/end' && method === 'POST') {
    const token = req.headers['x-shift-token'];
    shifts.delete(token);
    log('poste clos (idempotent)');
    return send(res, 200, '');
  }

  if (path === '/api/agent/sites') return send(res, 200, [SITE_ID]);

  if (path === '/api/site/config') {
    return send(res, 200, {
      siteLabel: 'Site de test — Abidjan Plateau',
      postes: [
        { id: 'P-ENTREE', nom: 'Poste Entrée principale' },
        { id: 'P-LIVRAISON', nom: 'Poste Livraisons' },
      ],
      params: { fenetreAvantMin: 20, fenetreApresMin: 15, ttlListeLocaleHeures: 4 },
    });
  }

  if (path === '/api/agent/expected-today') {
    const statusOf = (v) => (v.present ? 'sur site' : v.statut === 'révoqué' ? 'révoqué' : v.exited ? 'sorti' : 'attendu');
    return send(res, 200, [...visits.values()].filter((v) => !v.horsListe).map((v) => ({
      visitorName: v.nom,
      status: statusOf(v),
      windowStart: new Date(v.debut).toISOString(),
      windowEnd: new Date(v.fin).toISOString(),
    })));
  }

  if (path === '/api/offline-list') {
    const listed = [...visits.values()].filter((v) => !v.horsListe);
    const statutOf = (v) => (v.present ? 'sur site' : v.statut === 'révoqué' ? 'révoqué' : v.exited ? 'sorti' : 'attendu');
    return send(res, 200, {
      generatedAtUtc: new Date().toISOString(),
      expiresAtUtc: new Date(Date.now() + 4 * 3600_000).toISOString(),
      visits: listed.map((v) => ({
        visitId: v.visitId,
        nom: v.nom,
        mode: v.mode === '30j' ? '30 jours' : 'unique',
        fenetreDebut: new Date(v.debut).toISOString(),
        fenetreFin: new Date(v.fin).toISOString(),
        statut: statutOf(v),
        present: v.present,
      })),
      // Chaîne JSON : l'app doit la parser une seconde fois.
      signedList: signEnvelope(
        listed.map((v) => ({
          visitId: v.visitId,
          visitToken: v.visitToken,
          scheduledAt: new Date(v.debut).toISOString(),
          isExcluded: v.exclu,
          isOnSite: v.present,
        })),
      ),
    });
  }

  if (path === '/api/scan' && method === 'POST') {
    if (!bearerShift(req)) {
      log('refusé : Bearer de poste absent');
      return send(res, 401, { error: 'Jeton de poste requis.' });
    }
    const body = (await readBody(req)) ?? {};
    let visit = null;
    try {
      const env = JSON.parse(body.signedQrPayload ?? '{}');
      const payloadBytes = Buffer.from(env.PayloadB64Url ?? '', 'base64url');
      const ok = crypto.verify(
        'sha256',
        payloadBytes,
        { key: crypto.createPublicKey(KEYS.publicPem), dsaEncoding: 'ieee-p1363' },
        Buffer.from(env.SignatureB64Url ?? '', 'base64url'),
      );
      if (ok) {
        const claims = JSON.parse(payloadBytes.toString('utf8'));
        if (claims.Exp * 1000 > Date.now()) {
          visit = [...visits.values()].find((v) => v.visitId === claims.VisitId) ?? null;
        }
      }
    } catch {
      visit = null;
    }
    const result = decideScan(visit, body.direction);
    log(`${body.direction} → ${result.verdictCode}`);
    return send(res, 200, { overstayMinutes: null, presenceMinutes: null, ...result });
  }

  if (path === '/api/scan/sync' && method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body)) {
      log('CORPS INVALIDE — un tableau nu est attendu, pas un objet');
      return send(res, 400, { error: 'Un tableau de scans hors ligne est attendu.' });
    }
    syncedScans.push(...body);
    // Un scan sur trois est déclaré en conflit, pour éprouver le chemin 409.
    const conflicts = body
      .filter((_, i) => i % 3 === 2)
      .map(() => ({ visitId: [...visits.values()][0].visitId, raison: 'Visite déjà clôturée côté serveur' }));
    const payload = { accepted: body.length - conflicts.length, conflicts };
    log(`${body.length} scan(s) resynchronisé(s), ${conflicts.length} conflit(s)`);
    return send(res, conflicts.length ? 409 : 200, payload);
  }

  return send(res, 404, { error: 'Route inconnue.' });
});

// ------------------------------------------------------- page des QR à scanner
async function page() {
  const svg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const enrolQr = await svg(JSON.stringify({ ticket: ENROLL_TICKET, baseUrl: BASE_URL }));

  const cards = [];
  for (const v of visits.values()) {
    cards.push(`<div class="card"><div class="qr">${await svg(qrFor(v))}</div>
      <h3>${v.nom}</h3><code>${v.attendu}</code><p>${v.note}</p></div>`);
  }
  cards.push(`<div class="card"><div class="qr">${await svg(forgedQr())}</div>
    <h3>QR forgé</h3><code>INVALID_SIGNATURE</code>
    <p>Signature authentique, payload remplacé après coup : doit être refusé en ligne comme hors ligne.</p></div>`);
  cards.push(`<div class="card"><div class="qr">${await svg('ceci-n-est-pas-un-qr-novacces')}</div>
    <h3>QR étranger</h3><code>INVALID_SIGNATURE</code><p>Contenu non conforme à l'enveloppe attendue.</p></div>`);

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NovAccès — banc de test</title><style>
:root{color-scheme:dark}
body{background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px}
h1{font-size:20px;letter-spacing:.5px} h2{font-size:15px;color:#f0b72f;margin-top:32px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;text-align:center}
.card h3{margin:10px 0 4px;font-size:14px}
.card p{color:#8b949e;font-size:11.5px;margin:6px 0 0;text-align:left}
.qr{background:#fff;border-radius:6px;padding:8px}
.qr svg{width:100%;height:auto;display:block}
code{color:#7ee787;font-size:11px;background:#0d1117;padding:2px 6px;border-radius:4px}
.enrol{max-width:300px} .enrol .qr{padding:12px}
.steps{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:4px 20px;max-width:760px}
.steps li{margin:10px 0} kbd{background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:1px 6px;font-size:12px}
.warn{color:#f0b72f}
</style></head><body>
<h1>NovAccès — banc de test local</h1>
<p class="warn">Serveur factice sur <kbd>${BASE_URL}</kbd> — aucune donnée réelle, aucun appel à la production.</p>

<h2>1 · Enrôler le terminal</h2>
<div class="card enrol"><div class="qr">${enrolQr}</div><h3>Ticket d'enrôlement</h3>
<p>Usage unique. Il porte aussi <code>baseUrl</code>, ce qui pointe l'app vers ce serveur sans toucher à la configuration.</p></div>

<h2>2 · Prendre le poste</h2>
<ol class="steps"><li>Matricule <kbd>${AGENT.matricule}</kbd> · code PIN <kbd>${AGENT.pin}</kbd></li>
<li>Site <kbd>${SITE_ID}</kbd>, puis choisir un poste de contrôle.</li></ol>

<h2>3 · Scanner les cas de test</h2>
<p>Le verdict attendu figure sous chaque nom. Basculez le sens ENTRÉE/SORTIE dans l'app pour éprouver les deux chemins.</p>
<div class="grid">${cards.join('')}</div>

<h2>4 · Éprouver le mode dégradé</h2>
<ol class="steps">
<li>Coupez le serveur : <kbd>curl -X POST ${BASE_URL}/__mock/offline</kbd></li>
<li>Le bandeau dégradé doit apparaître sous 30 s. Rescannez : les verdicts viennent désormais de la liste signée locale.</li>
<li>Rétablissez : <kbd>curl -X POST ${BASE_URL}/__mock/online</kbd> — la resynchronisation part seule et remonte un conflit sur trois.</li>
</ol></body></html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nBanc de test NovAccès`);
  console.log(`  page des QR : ${BASE_URL}/`);
  console.log(`  agent       : ${AGENT.matricule} / ${AGENT.pin}`);
  console.log(`  ticket      : ${ENROLL_TICKET}`);
  console.log('\nRequêtes :');
});
