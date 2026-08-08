import type { AccessMode, Direction, VerdictCode, VisitStatus } from '@/types/domain';

export const apiConfig = {
  baseUrl: process.env.EXPO_PUBLIC_API_URL?.trim() || 'https://api.sigasacces.com',
  timeoutMs: 10_000,
};

export function setBaseUrl(url: string) {
  apiConfig.baseUrl = url.trim().replace(/\/+$/, '');
}

// apiKey : secret opaque remis à l'activation, identité du terminal, stable
// jusqu'à révocation par l'admin. shiftToken : jeton de poste, délivré à la
// prise de poste et porté par l'en-tête Authorization.
let apiKey: string | null = null;
let shiftToken: string | null = null;
let siteId: string | null = null;

export function setApiKey(key: string | null) {
  apiKey = key;
}

export function setShiftToken(token: string | null) {
  shiftToken = token;
}

export function setSiteId(id: string | null) {
  siteId = id;
}

export function currentShiftToken(): string | null {
  return shiftToken;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Serveur injoignable : déclencheur du mode dégradé, pas un refus d'accès. */
export class NetworkError extends Error {
  constructor(message = 'Serveur central injoignable') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Réponse 2xx illisible : l'agent doit voir un défaut d'intégration, pas un refus. */
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

export function errorMessage(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Serveur central injoignable — vérifiez le réseau du terminal.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return err.message && err.message !== 'HTTP 401'
        ? err.message
        : 'Matricule ou code PIN incorrect (ou session expirée).';
    }
    if (err.status === 403) {
      return err.message && err.message !== 'HTTP 403'
        ? err.message
        : "Ce terminal n'est pas autorisé pour cette opération.";
    }
    if (err.status === 410) return "Ticket d'enrôlement expiré ou déjà utilisé — demandez-en un nouveau.";
    if (err.status === 429) return 'Trop de tentatives — patientez avant de réessayer.';
    return err.message;
  }
  if (err instanceof ContractError) return err.message;
  return (err as Error)?.message ?? 'Erreur inattendue.';
}

interface RequestOptions {
  extraHeaders?: Record<string, string>;
  /** Statuts d'erreur dont le corps porte une réponse métier exploitable. */
  acceptStatus?: number[];
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiConfig.timeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiKey) headers['X-Api-Key'] = apiKey;
  if (shiftToken) headers.Authorization = `Bearer ${shiftToken}`;
  if (siteId) headers['X-Site-Id'] = siteId;
  if (options?.extraHeaders) Object.assign(headers, options.extraHeaders);

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

  if (!res.ok && !options?.acceptStatus?.includes(res.status)) {
    throw new ApiError(res.status, extractError(text) ?? `HTTP ${res.status}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

function extractError(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['error', 'message', 'title', 'detail']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) return value;
    }
  } catch {
    // corps non-JSON
  }
  return text.slice(0, 200);
}

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

// Clés de vérification indexées par `kid` : les clés retirées restent
// nécessaires pour les QR émis avant la dernière rotation.
function parsePublicKeys(raw: unknown): Record<string, string> {
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
  return keys;
}

export interface DeviceActivationRequest {
  ticket: string;
  deviceInstanceId: string;
  devicePublicKeyPem: string;
  proofSignature: string;
}

export interface DeviceActivationResult {
  terminalId?: string;
  label?: string;
  /** Sites autorisés pour ce terminal ; une seule entrée = terminal mono-site. */
  siteIds: string[];
  apiKey: string;
}

function parseDeviceActivation(raw: unknown): DeviceActivationResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/device-enrollments/activate', raw);
  const key = pickString(data, 'apiKey', 'token', 'accessToken', 'deviceToken', 'terminalKey');
  if (!key) throw new ContractError('/api/device-enrollments/activate — apiKey', raw);
  const siteIds = Array.isArray(data.siteIds)
    ? data.siteIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : pickArray(data, 'siteIds').map((v) => (typeof v === 'string' ? v : String(v)));
  return {
    terminalId: pickString(data, 'terminalId'),
    label: pickString(data, 'label', 'siteLabel'),
    siteIds,
    apiKey: key,
  };
}

export interface ShiftStartResult {
  shiftToken: string;
  matricule: string;
  displayName?: string;
  expiresAt?: number;
}

function parseShiftStart(raw: unknown, fallbackMatricule: string): ShiftStartResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/agent/shift/start', raw);
  const token = pickString(data, 'shiftToken', 'token', 'accessToken', 'jwt');
  if (!token) throw new ContractError('/api/agent/shift/start — shiftToken', raw);
  const agent = asObject(data.agent) ?? data;
  return {
    shiftToken: token,
    matricule: pickString(data, 'matricule') ?? pickString(agent, 'matricule', 'badge', 'agentId') ?? fallbackMatricule,
    displayName: pickString(data, 'displayName') ?? pickString(agent, 'displayName', 'nom', 'name', 'fullName'),
    expiresAt: pickDate(data, 'expiresAt'),
  };
}

export interface SiteRef {
  id: string;
  label: string;
}

export interface SiteConfig {
  siteLabel?: string;
  checkpoints: SiteRef[];
}

function parseCheckpoint(raw: Json): SiteRef | null {
  const id = pickString(raw, 'id', 'checkpointId', 'code');
  const nom = pickString(raw, 'nom', 'label', 'name');
  if (!id && !nom) return null;
  return { id: id ?? (nom as string), label: nom ?? (id as string) };
}

// Tableau nu de chaînes : le serveur ne renvoie pas de libellé, seul
// GET /api/site/config en fournit un une fois le site sélectionné.
function parseSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ContractError('/api/agent/sites', raw);
  return raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
}

function parseSiteConfig(raw: unknown): SiteConfig {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/site/config', raw);
  const siteLabel = pickString(data, 'siteLabel', 'label', 'nom', 'name');
  const checkpoints = pickArray(data, 'postes', 'checkpoints', 'points', 'items', 'data', 'checkPoints')
    .map(parseCheckpoint)
    .filter((site): site is SiteRef => site !== null);

  // Si le serveur ne renvoie aucun poste de contrôle spécifique, fournir le poste principal par défaut
  if (checkpoints.length === 0) {
    checkpoints.push({
      id: 'default',
      label: siteLabel ?? 'Poste principal',
    });
  }

  return {
    siteLabel,
    checkpoints,
  };
}

function parseAccessMode(raw: string | undefined): AccessMode {
  const value = (raw ?? '').toLowerCase();
  return value.includes('30') || value.includes('recurr') ? '30j' : 'unique';
}

// Le serveur envoie le nom BRUT de l'enum VisitStatus (C#, .ToString()) :
// "Valid" | "Consumed" | "Revoked" | "Expired" (Domain/Enums/VisitStatus.cs)
// -- PAS de libellé français ("sorti", "consommé"...). Un ancien parseur
// cherchait des mots français qui ne correspondaient jamais à ces valeurs,
// faisant retomber Consumed/Revoked sur le cas par défaut "valide" : un
// visiteur reparti (Consumed, plus present) semblait alors "non venu" une
// fois sa fenêtre dépassée, au lieu de "SORTI" (régression du 08/08/2026).
// La présence réelle vient du champ `present`/`isOnSite` dédié, pas d'ici.
function parseVisitStatus(raw: string | undefined): { statut: VisitStatus; present: boolean } {
  const value = (raw ?? '').toLowerCase();
  if (value === 'revoked') return { statut: 'revoque', present: false };
  if (value === 'consumed') return { statut: 'consomme', present: false };
  // "valid", "expired" (ne devrait jamais apparaître ici -- filtré côté
  // serveur), ou toute valeur inconnue : traité comme encore attendu.
  return { statut: 'valide', present: false };
}

/** Ligne de `visits[]` en clair : affichage de l'écran « Attendus » seulement. */
export interface ListedVisit {
  visitId: string;
  nom: string;
  mode: AccessMode;
  statut: VisitStatus;
  fenetreDebut?: number;
  fenetreFin?: number;
  present: boolean;
  overstayMinutes?: number;
}

function parseListedVisit(raw: Json): ListedVisit | null {
  const visitId = pickString(raw, 'visitId');
  const nom = pickString(raw, 'nom');
  if (!visitId || !nom) return null;
  const status = parseVisitStatus(pickString(raw, 'statut'));
  return {
    visitId,
    nom,
    mode: parseAccessMode(pickString(raw, 'mode')),
    statut: status.statut,
    fenetreDebut: pickDate(raw, 'fenetreDebut'),
    fenetreFin: pickDate(raw, 'fenetreFin'),
    present: pickBool(raw, 'present') ?? status.present,
    overstayMinutes: pickNumber(raw, 'overstayMinutes'),
  };
}

export interface ExpectedVisitor {
  visitId?: string;
  nom: string;
  mode?: AccessMode;
  statut: VisitStatus;
  present: boolean;
  fenetreDebut?: number;
  fenetreFin?: number;
}

function parseExpectedVisitors(raw: unknown): ExpectedVisitor[] {
  const list = Array.isArray(raw) ? raw : pickArray(asObject(raw) ?? {}, 'visits', 'items', 'visitors', 'data');
  return list
    .map((item) => asObject(item))
    .filter((item): item is Json => item !== null)
    .map((item): ExpectedVisitor | null => {
      const nom = pickString(item, 'visitorName', 'nom', 'name', 'visitor');
      if (!nom) return null;
      const status = parseVisitStatus(pickString(item, 'status', 'statut'));
      return {
        visitId: pickString(item, 'visitId', 'id', 'ticketId', 'ticket'),
        nom,
        mode: parseAccessMode(pickString(item, 'mode')),
        statut: status.statut,
        present: pickBool(item, 'present', 'isOnSite', 'isGranted') ?? status.present,
        fenetreDebut: pickDate(item, 'windowStart', 'fenetreDebut', 'debut'),
        fenetreFin: pickDate(item, 'windowEnd', 'fenetreFin', 'fin'),
      };
    })
    .filter((v): v is ExpectedVisitor => v !== null);
}

export interface OfflineListResponse {
  /** Enveloppe signée sérialisée en chaîne JSON — à parser une seconde fois. */
  signedList: string;
  visits: ListedVisit[];
  expiresAt?: number;
}

function parseOfflineListResponse(raw: unknown): OfflineListResponse {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/offline-list', raw);
  const signedList = pickString(data, 'signedList');
  if (!signedList) throw new ContractError('/api/offline-list — signedList', raw);
  return {
    signedList,
    visits: pickArray(data, 'visits')
      .map(parseListedVisit)
      .filter((v): v is ListedVisit => v !== null),
    expiresAt: pickDate(data, 'expiresAtUtc'),
  };
}

// Entrée de la liste signée : seule source autorisée pour un verdict hors ligne.
// Le `visitToken` qui l'accompagne n'est pas repris : la resynchronisation
// renvoie le QR signé, à charge du serveur d'en redériver la visite.
export interface SignedVisit {
  visitId: string;
  scheduledAt?: number;
  isExcluded: boolean;
  isOnSite: boolean;
}

export function parseSignedVisits(payload: unknown): SignedVisit[] {
  const list = Array.isArray(payload)
    ? payload
    : pickArray(asObject(payload) ?? {}, 'visits', 'items', 'entries');
  return list
    .map((item) => asObject(item))
    .filter((item): item is Json => item !== null)
    .map((item): SignedVisit | null => {
      const visitId = pickString(item, 'visitId', 'VisitId');
      if (!visitId) return null;
      return {
        visitId,
        scheduledAt: pickDate(item, 'scheduledAt', 'ScheduledAt'),
        isExcluded: pickBool(item, 'isExcluded', 'IsExcluded') ?? false,
        isOnSite: pickBool(item, 'isOnSite', 'IsOnSite') ?? false,
      };
    })
    .filter((v): v is SignedVisit => v !== null);
}

/** Claims du QR visiteur, une fois l'enveloppe vérifiée. `exp` en secondes Unix. */
export interface QrClaims {
  visitId: string;
  exp?: number;
}

export function parseQrClaims(payload: unknown): QrClaims | null {
  const data = asObject(payload);
  if (!data) return null;
  const visitId = pickString(data, 'VisitId', 'visitId');
  if (!visitId) return null;
  return { visitId, exp: pickNumber(data, 'Exp', 'exp') };
}

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
  overstayMinutes?: number;
}

function parseScanResult(raw: unknown): ScanResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/scan', raw);
  const verdictCode = pickString(data, 'verdictCode');
  if (!verdictCode) throw new ContractError('/api/scan — verdictCode', raw);
  return {
    isGranted: pickBool(data, 'isGranted') ?? false,
    isCheckOut: pickBool(data, 'isCheckOut') ?? false,
    isSecurityEvent: pickBool(data, 'isSecurityEvent') ?? false,
    verdictCode: verdictCode as VerdictCode,
    visitorName: pickString(data, 'visitorName'),
    overstayMinutes: pickNumber(data, 'overstayMinutes'),
  };
}

// Corps de `POST /api/scan/sync` : le serveur redérive la visite depuis le QR
// signé, d'où l'absence de visitToken. Ni `wasGranted` ni `wasSecurityEvent` —
// le verdict prononcé hors ligne tient dans `offlineVerdict`.
export interface OfflineScanPayload {
  signedQrPayload: string;
  direction: ApiDirection;
  agentId: string;
  scannedAtUtc: string;
  offlineVerdict: string;
}

export interface ResyncConflict {
  visitId?: string;
  raison: string;
}

export interface ResyncResult {
  accepted: number;
  conflicts: ResyncConflict[];
}

function parseSyncResult(raw: unknown, sent: number): ResyncResult {
  const data = asObject(raw);
  if (!data) return { accepted: sent, conflicts: [] };
  const conflicts = pickArray(data, 'conflicts').map((item) => ({
    visitId: pickString(item, 'visitId'),
    raison: pickString(item, 'raison') ?? 'Écart signalé par le serveur',
  }));
  return { accepted: pickNumber(data, 'accepted') ?? sent - conflicts.length, conflicts };
}

export const api = {
  // Seul l'aboutissement de l'appel compte : c'est lui qui distingue « réseau
  // présent » de « serveur joignable ».
  async health(): Promise<void> {
    await request<unknown>('GET', '/api/health');
  },

  async publicKeys(): Promise<Record<string, string>> {
    return parsePublicKeys(await request<unknown>('GET', '/api/keys/public'));
  },

  async activateDevice(payload: DeviceActivationRequest): Promise<DeviceActivationResult> {
    return parseDeviceActivation(
      await request<unknown>('POST', '/api/device-enrollments/activate', payload),
    );
  },

  async agentSites(): Promise<string[]> {
    return parseSites(await request<unknown>('GET', '/api/agent/sites'));
  },

  async siteConfig(): Promise<SiteConfig> {
    return parseSiteConfig(await request<unknown>('GET', '/api/site/config'));
  },

  async shiftStart(matricule: string, pin: string): Promise<ShiftStartResult> {
    const raw = await request<unknown>('POST', '/api/agent/shift/start', { matricule, pin });
    return parseShiftStart(raw, matricule);
  },

  // Idempotent : rejouer l'appel, ou l'appeler après qu'un autre agent a ouvert
  // un poste sur le même terminal, renvoie 200 sans rien changer.
  async shiftEnd(token?: string): Promise<void> {
    try {
      const extraHeaders = token ? { 'X-Shift-Token': token } : undefined;
      await request<unknown>('POST', '/api/agent/shift/end', undefined, { extraHeaders });
    } catch {
      // idempotent
    }
  },

  async expectedToday(): Promise<ExpectedVisitor[]> {
    return parseExpectedVisitors(await request<unknown>('GET', '/api/agent/expected-today'));
  },

  async offlineList(): Promise<OfflineListResponse> {
    return parseOfflineListResponse(await request<unknown>('GET', '/api/offline-list'));
  },

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

  // Code de secours (alternative au QR, visiteur sans téléphone fonctionnel) —
  // route DISTINCTE de /api/scan : le code n'est pas un JWT signé, l'envoyer à
  // /api/scan échouerait toujours en INVALID_SIGNATURE. TOUJOURS en ligne,
  // aucun repli hors-ligne (voir ScanManualCodeCommand côté API : résoudre le
  // code EST la recherche en base, impossible à vérifier localement).
  async scanManualCode(code: string, direction: Direction, checkpointId: string): Promise<ScanResult> {
    return parseScanResult(
      await request<unknown>('POST', '/api/scan/manual-code', {
        code,
        direction: toApiDirection(direction),
        checkpointId,
      }),
    );
  },

  // /api/agent/resync sert l'app MAUI historique et attend un autre corps de
  // requête : c'est /api/scan/sync qui est la route du contrat React Native.
  // Le corps est un tableau nu, pas un objet enveloppant. 409 n'est pas une
  // erreur ici — il porte le même corps que 200, avec les écarts constatés.
  async resync(scans: OfflineScanPayload[], _agentId?: string): Promise<ResyncResult> {
    const raw = await request<unknown>('POST', '/api/scan/sync', scans, {
      acceptStatus: [409],
    });
    return parseSyncResult(raw, scans.length);
  },
};
