import type { AccessMode, Direction, VerdictCode, VisitStatus } from '@/types/domain';

/**
 * Client HTTP de l'API NOVACCÈS (`NovAcces.Api`).
 *
 * Chemins et corps de requête calqués sur le contrat OpenAPI publié
 * (https://api.sigasacces.com/swagger/v1/swagger.json). Ce contrat ne décrit
 * AUCUN schéma de réponse : chaque opération y est déclarée « 200 OK » sans
 * corps typé. Les réponses sont donc normalisées ici de façon défensive —
 * chaque hypothèse est signalée par un commentaire `CONTRAT À CONFIRMER` et
 * regroupée dans la section « Normalisation » pour être corrigée en un seul
 * endroit dès que le backend publiera ses schémas.
 */

export const apiConfig = {
  /** Serveur de production par défaut ; surchargeable par site à l'enrôlement. */
  baseUrl: process.env.EXPO_PUBLIC_API_URL?.trim() || 'https://api.sigasacces.com',
  timeoutMs: 10_000,
};

export function setBaseUrl(url: string) {
  apiConfig.baseUrl = url.trim().replace(/\/+$/, '');
}

// ─── Session ────────────────────────────────────────────────────────────────

/**
 * Deux jetons distincts, dans cet ordre :
 *
 *  - `deviceToken` — délivré à l'activation du terminal. Il porte l'identité de
 *    l'APPAREIL et sert à joindre les endpoints d'amorçage (`/api/agent/sites`,
 *    `/api/agent/shift/start`) avant qu'un agent ne soit identifié.
 *  - `agentToken` — délivré à la prise de poste. Il porte l'identité de
 *    l'AGENT et prime sur le précédent tant que le poste est ouvert.
 *
 * L'API répond `WWW-Authenticate: Bearer` sur 401 : les deux sont transmis en
 * `Authorization: Bearer`.
 */
let deviceToken: string | null = null;
let agentToken: string | null = null;
let siteId: string | null = null;

export function setDeviceToken(token: string | null) {
  deviceToken = token;
}

export function setAgentToken(token: string | null) {
  agentToken = token;
}

export function setSiteId(id: string | null) {
  siteId = id;
}

export function clearSession() {
  deviceToken = null;
  agentToken = null;
  siteId = null;
}

// ─── Erreurs ────────────────────────────────────────────────────────────────

/** Réponse HTTP non-2xx : le serveur a répondu, la requête est en cause. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Serveur injoignable ou délai dépassé : c'est le déclencheur du mode dégradé
 * (liste locale signée), PAS un refus d'accès.
 */
export class NetworkError extends Error {
  constructor(message = 'Serveur central injoignable') {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Le serveur a répondu 2xx mais dans une forme que l'app ne sait pas lire.
 * Distinguée d'`ApiError` pour que le terminal ne présente jamais un défaut
 * d'intégration comme un refus d'accès : l'agent doit voir « contrat serveur
 * inattendu », pas « accès refusé ».
 */
export class ContractError extends Error {
  constructor(what: string, received: unknown) {
    super(`Réponse serveur inattendue (${what}) — clés reçues : ${describeKeys(received)}`);
    this.name = 'ContractError';
  }
}

function describeKeys(value: unknown): string {
  if (value && typeof value === 'object') return Object.keys(value).join(', ') || '(objet vide)';
  return typeof value;
}

/** Message affichable à l'agent — jamais une pile technique. */
export function errorMessage(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Serveur central injoignable — vérifiez le réseau du terminal.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expirée — reprenez la prise de poste.';
    if (err.status === 403) return "Ce terminal n'est pas autorisé pour cette opération.";
    if (err.status === 429) return 'Trop de tentatives — patientez avant de réessayer.';
    return err.message;
  }
  if (err instanceof ContractError) return err.message;
  return (err as Error)?.message ?? 'Erreur inattendue.';
}

// ─── Transport ──────────────────────────────────────────────────────────────

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiConfig.timeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const bearer = agentToken ?? deviceToken;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  // Middleware multi-tenant côté serveur (TenantResolutionMiddleware).
  if (siteId) headers['X-Site-Id'] = siteId;

  let res: Response;
  try {
    res = await fetch(`${apiConfig.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new ApiError(res.status, extractError(text) ?? `HTTP ${res.status}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** L'API renvoie ses refus sous la forme `{ "error": "…" }`. */
function extractError(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['error', 'message', 'title', 'detail']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) return value;
    }
  } catch {
    /* corps non-JSON : renvoyé tel quel ci-dessous */
  }
  return text.slice(0, 200);
}

// ─── Normalisation des réponses ─────────────────────────────────────────────
//
// Le contrat OpenAPI ne typant aucune réponse, chaque lecture accepte les
// graphies plausibles (camelCase .NET, libellés français du contrat PDF) et
// échoue bruyamment via ContractError plutôt que de deviner en silence.

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function pickString(source: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function pickBool(source: Json, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof source[key] === 'boolean') return source[key] as boolean;
  }
  return undefined;
}

function pickNumber(source: Json, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Date ISO 8601 → timestamp local, ou `undefined` si absente/illisible. */
function pickDate(source: Json, ...keys: string[]): number | undefined {
  const raw = pickString(source, ...keys);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function pickArray(source: Json, ...keys: string[]): Json[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value.filter((v): v is Json => asObject(v) !== null);
  }
  return [];
}

// ─── Santé et clés publiques (formes vérifiées en production) ───────────────

export interface HealthResult {
  status: string;
  /** Heure du serveur : toute décision horaire est serveur (REQ-SEC-02). */
  serverTimeUtc?: number;
}

export interface PublicKeysResult {
  /** Clés publiques ES256 par `kid`, courante et retirées encore acceptées. */
  keys: Record<string, string>;
  currentKid: string;
}

function parsePublicKeys(raw: unknown): PublicKeysResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/keys/public', raw);

  const currentKid = pickString(data, 'kid', 'currentKid') ?? 'current';
  const currentPem = pickString(data, 'publicKeyPem', 'pem', 'publicKey');
  if (!currentPem) throw new ContractError('/api/keys/public — clé courante', raw);

  const keys: Record<string, string> = { [currentKid]: currentPem };
  for (const retired of pickArray(data, 'retiredKeys', 'retired')) {
    const kid = pickString(retired, 'kid');
    const pem = pickString(retired, 'publicKeyPem', 'pem', 'publicKey');
    if (kid && pem) keys[kid] = pem;
  }
  return { keys, currentKid };
}

// ─── Enrôlement du terminal ─────────────────────────────────────────────────

export interface DeviceActivationRequest {
  ticket: string;
  deviceInstanceId: string;
  devicePublicKeyPem: string;
  proofSignature: string;
}

export interface DeviceActivationResult {
  /** Jeton d'appareil ; à conserver en stockage sécurisé. */
  token: string;
  /** Site auquel le terminal est lié, s'il est déjà déterminé à l'activation. */
  siteId?: string;
  siteLabel?: string;
}

function parseDeviceActivation(raw: unknown): DeviceActivationResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/device-enrollments/activate', raw);
  // CONTRAT À CONFIRMER : nom du champ portant le jeton d'appareil.
  const token = pickString(data, 'token', 'accessToken', 'deviceToken', 'apiKey', 'terminalKey');
  if (!token) throw new ContractError('/api/device-enrollments/activate — jeton', raw);
  return {
    token,
    siteId: pickString(data, 'siteId', 'site'),
    siteLabel: pickString(data, 'siteLabel', 'siteName', 'label'),
  };
}

// ─── Prise de poste ─────────────────────────────────────────────────────────

export interface ShiftStartResult {
  /** Jeton de session de l'agent, si l'API en délivre un distinct. */
  token?: string;
  matricule: string;
  nom?: string;
  shiftId?: string;
}

function parseShiftStart(raw: unknown, fallbackMatricule: string): ShiftStartResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/agent/shift/start', raw);
  const agent = asObject(data.agent) ?? data;
  return {
    // CONTRAT À CONFIRMER : jeton de session agent (peut être absent si le
    // jeton d'appareil suffit pour toute la durée du poste).
    token: pickString(data, 'token', 'accessToken', 'jwt'),
    matricule: pickString(agent, 'matricule', 'badge', 'agentId') ?? fallbackMatricule,
    nom: pickString(agent, 'nom', 'name', 'displayName', 'fullName'),
    shiftId: pickString(data, 'shiftId', 'id', 'posteId'),
  };
}

// ─── Sites et configuration du poste ────────────────────────────────────────

export interface SiteRef {
  id: string;
  label: string;
}

export interface SiteConfig {
  siteLabel?: string;
  /** Postes de contrôle du site (« Poste 1 », « Entrée principale »…). */
  checkpoints: SiteRef[];
  /** Fenêtre de validité, en minutes, affichée à l'agent. */
  windowBeforeMin?: number;
  windowAfterMin?: number;
  /** TTL maximal de la liste locale signée, en heures (≤ 4 — REQ-SEC-06). */
  offlineListTtlHours?: number;
}

function parseSiteRef(raw: Json): SiteRef | null {
  const id = pickString(raw, 'id', 'checkpointId', 'siteId', 'code');
  const label = pickString(raw, 'nom', 'label', 'name', 'siteLabel');
  if (!id && !label) return null;
  return { id: id ?? (label as string), label: label ?? (id as string) };
}

function parseSites(raw: unknown): SiteRef[] {
  const list = Array.isArray(raw) ? raw : pickArray(asObject(raw) ?? {}, 'sites', 'items', 'data');
  const sites = list
    .map((item) => asObject(item))
    .filter((item): item is Json => item !== null)
    .map(parseSiteRef)
    .filter((site): site is SiteRef => site !== null);
  if (sites.length === 0) throw new ContractError('/api/agent/sites', raw);
  return sites;
}

function parseSiteConfig(raw: unknown): SiteConfig {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/site/config', raw);
  const params = asObject(data.params) ?? data;
  const checkpoints = pickArray(data, 'postes', 'checkpoints', 'points')
    .map(parseSiteRef)
    .filter((site): site is SiteRef => site !== null);
  return {
    siteLabel: pickString(data, 'siteLabel', 'label', 'nom', 'name'),
    checkpoints,
    windowBeforeMin: pickNumber(params, 'fenetreAvantMin', 'windowBeforeMinutes'),
    windowAfterMin: pickNumber(params, 'fenetreApresMin', 'windowAfterMinutes'),
    offlineListTtlHours: pickNumber(params, 'ttlListeLocaleHeures', 'offlineListTtlHours'),
  };
}

// ─── Visites attendues et liste hors ligne ──────────────────────────────────

export interface ExpectedVisit {
  visitId: string;
  nom: string;
  mode: AccessMode;
  statut: VisitStatus;
  /** Bornes de la fenêtre de validité, calculées par le serveur. */
  fenetreDebut?: number;
  fenetreFin?: number;
  present: boolean;
}

function parseExpectedVisit(raw: Json): ExpectedVisit | null {
  const visitId = pickString(raw, 'visitId', 'id', 'visitToken');
  const nom = pickString(raw, 'nom', 'visitorName', 'name', 'visiteur');
  if (!visitId || !nom) return null;

  const rawMode = (pickString(raw, 'mode', 'accessMode') ?? '').toLowerCase();
  const rawStatut = (pickString(raw, 'statut', 'status') ?? '').toLowerCase();

  return {
    visitId,
    nom,
    mode: rawMode.includes('30') || rawMode.includes('recurr') ? '30j' : 'unique',
    statut: rawStatut.includes('revoq') || rawStatut.includes('revok')
      ? 'revoque'
      : rawStatut.includes('consom') || rawStatut.includes('consumed')
        ? 'consomme'
        : 'valide',
    fenetreDebut: pickDate(raw, 'fenetreDebut', 'windowStart', 'validFrom'),
    fenetreFin: pickDate(raw, 'fenetreFin', 'windowEnd', 'validUntil'),
    present: pickBool(raw, 'present', 'isOnSite', 'onSite') ?? false,
  };
}

function parseExpectedVisits(raw: unknown): ExpectedVisit[] {
  const list = Array.isArray(raw)
    ? (raw.filter((v) => asObject(v)) as Json[])
    : pickArray(asObject(raw) ?? {}, 'visits', 'items', 'expected', 'data');
  return list.map(parseExpectedVisit).filter((v): v is ExpectedVisit => v !== null);
}

export interface OfflineList {
  /** JWS complet tel que reçu — conservé pour re-vérification après stockage. */
  jws?: string;
  visits: ExpectedVisit[];
  generatedAt?: number;
  /** Au-delà, toute validation hors ligne est refusée (REQ-SEC-06). */
  expiresAt?: number;
}

/**
 * La liste du jour est censée être servie enveloppée dans un JWS ES256. Selon
 * que le serveur renvoie le JWS brut ou un objet l'encapsulant, la charge
 * utile est extraite puis vérifiée par l'appelant (`verifyJws`).
 */
function parseOfflineListEnvelope(raw: unknown): { jws?: string; payload: unknown } {
  if (typeof raw === 'string') return { jws: raw, payload: undefined };
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/agent/offline-list', raw);
  const jws = pickString(data, 'jws', 'token', 'signedList', 'payload', 'signedPayload');
  // Un JWS compact contient exactement deux points et aucune espace.
  if (jws && jws.split('.').length === 3) return { jws, payload: undefined };
  return { jws: undefined, payload: data };
}

export function parseOfflineListPayload(raw: unknown, jws?: string): OfflineList {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/agent/offline-list — charge utile', raw);
  return {
    jws,
    visits: parseExpectedVisits(data),
    generatedAt: pickDate(data, 'generatedAtUtc', 'generatedAt'),
    expiresAt: pickDate(data, 'expiresAtUtc', 'expiresAt'),
  };
}

// ─── Scan ───────────────────────────────────────────────────────────────────

/** Sens du poste côté API : enum .NET `CheckpointDirection`. */
export type ApiDirection = 'Entry' | 'Exit';

export function toApiDirection(direction: Direction): ApiDirection {
  return direction === 'entree' ? 'Entry' : 'Exit';
}

export interface ScanResult {
  isGranted: boolean;
  isCheckOut: boolean;
  isSecurityEvent: boolean;
  verdictCode: VerdictCode;
  visitorName?: string;
  /** Dépassement de la durée prévue, en minutes — informatif, jamais bloquant. */
  overstayMinutes?: number;
}

function parseScanResult(raw: unknown): ScanResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/scan', raw);
  const verdictCode = pickString(data, 'verdictCode', 'verdict', 'code');
  if (!verdictCode) throw new ContractError('/api/scan — verdictCode', raw);
  return {
    isGranted: pickBool(data, 'isGranted', 'granted') ?? false,
    isCheckOut: pickBool(data, 'isCheckOut', 'checkOut') ?? false,
    isSecurityEvent: pickBool(data, 'isSecurityEvent', 'securityEvent') ?? false,
    verdictCode: verdictCode as VerdictCode,
    visitorName: pickString(data, 'visitorName', 'nom', 'name'),
    overstayMinutes: pickNumber(data, 'overstayMinutes', 'overstay'),
  };
}

// ─── Resynchronisation des scans hors ligne ─────────────────────────────────

/** `OfflineScanDto` du contrat OpenAPI (`POST /api/agent/resync`). */
export interface OfflineScanPayload {
  visitToken: string;
  direction: ApiDirection;
  wasGranted: boolean;
  occurredAt: string;
  verdictCode: string;
  wasSecurityEvent: boolean;
  signedQrPayload: string;
}

export interface ResyncConflict {
  visitId?: string;
  raison: string;
}

export interface ResyncResult {
  accepted: number;
  conflicts: ResyncConflict[];
}

function parseResync(raw: unknown, sent: number): ResyncResult {
  const data = asObject(raw);
  if (!data) return { accepted: sent, conflicts: [] };
  const conflicts = pickArray(data, 'conflicts', 'conflits', 'ecarts').map((item) => ({
    visitId: pickString(item, 'visitId', 'id', 'visitToken'),
    raison: pickString(item, 'raison', 'reason', 'message') ?? 'Écart signalé par le serveur',
  }));
  return { accepted: pickNumber(data, 'accepted', 'acceptes') ?? sent - conflicts.length, conflicts };
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export const api = {
  /** Pastille EN LIGNE / HORS LIGNE : « réseau présent » ≠ « serveur joignable ». */
  async health(): Promise<HealthResult> {
    const raw = await request<unknown>('GET', '/api/health');
    const data = asObject(raw) ?? {};
    return {
      status: pickString(data, 'status') ?? 'ok',
      serverTimeUtc: pickDate(data, 'serverTimeUtc', 'utc'),
    };
  },

  /** Clés ES256 de vérification hors ligne — rotation sans republier l'app. */
  async publicKeys(): Promise<PublicKeysResult> {
    return parsePublicKeys(await request<unknown>('GET', '/api/keys/public'));
  },

  /** Active le terminal avec le ticket QR temporaire, à usage unique. */
  async activateDevice(payload: DeviceActivationRequest): Promise<DeviceActivationResult> {
    return parseDeviceActivation(
      await request<unknown>('POST', '/api/device-enrollments/activate', payload),
    );
  },

  /** Sites que ce terminal est autorisé à servir. */
  async agentSites(): Promise<SiteRef[]> {
    return parseSites(await request<unknown>('GET', '/api/agent/sites'));
  },

  /** Postes de contrôle et paramètres du site courant. */
  async siteConfig(): Promise<SiteConfig> {
    return parseSiteConfig(await request<unknown>('GET', '/api/site/config'));
  },

  /** Prise de poste : identifie l'agent (matricule + PIN) et ouvre un poste. */
  async shiftStart(matricule: string, pin: string): Promise<ShiftStartResult> {
    const raw = await request<unknown>('POST', '/api/agent/shift/start', { matricule, pin });
    return parseShiftStart(raw, matricule);
  },

  /** Visiteurs attendus aujourd'hui — données minimales (moindre privilège). */
  async expectedToday(): Promise<ExpectedVisit[]> {
    return parseExpectedVisits(await request<unknown>('GET', '/api/agent/expected-today'));
  },

  /** Liste signée du jour, pour le mode dégradé (TTL ≤ 4 h). */
  async offlineList(): Promise<{ jws?: string; payload: unknown }> {
    return parseOfflineListEnvelope(await request<unknown>('GET', '/api/agent/offline-list'));
  },

  /**
   * Scan d'un QR au poste. L'arbre de décision complet (fenêtre, anti-rejeu,
   * exclusion, cycle entrée/sortie) vit côté serveur : l'app affiche le verdict
   * sans jamais le recalculer en ligne.
   */
  async scan(
    signedQrPayload: string,
    direction: Direction,
    agentId: string,
    checkpointId: string,
  ): Promise<ScanResult> {
    return parseScanResult(
      await request<unknown>('POST', '/api/scan', {
        signedQrPayload,
        direction: toApiDirection(direction),
        agentId,
        checkpointId,
      }),
    );
  },

  /** Rejoue les scans hors-ligne contre le registre central et remonte les écarts. */
  async resync(scans: OfflineScanPayload[]): Promise<ResyncResult> {
    const raw = await request<unknown>('POST', '/api/agent/resync', { scans });
    return parseResync(raw, scans.length);
  },
};
