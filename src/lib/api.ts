import type { AccessMode, Direction, VerdictCode, VisitStatus } from '@/types/domain';

// Le contrat OpenAPI ne type aucune réponse. Les parseurs ci-dessous acceptent
// plusieurs graphies et échouent via ContractError.

export const apiConfig = {
  baseUrl: process.env.EXPO_PUBLIC_API_URL?.trim() || 'https://api.sigasacces.com',
  timeoutMs: 10_000,
};

export function setBaseUrl(url: string) {
  apiConfig.baseUrl = url.trim().replace(/\/+$/, '');
}

// deviceToken : délivré à l'activation, identité de l'appareil.
// agentToken : délivré à la prise de poste, prime tant que le poste est ouvert.
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
    if (err.status === 401) return 'Session expirée — reprenez la prise de poste.';
    if (err.status === 403) return "Ce terminal n'est pas autorisé pour cette opération.";
    if (err.status === 429) return 'Trop de tentatives — patientez avant de réessayer.';
    return err.message;
  }
  if (err instanceof ContractError) return err.message;
  return (err as Error)?.message ?? 'Erreur inattendue.';
}

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
  token: string;
  siteId?: string;
  siteLabel?: string;
}

function parseDeviceActivation(raw: unknown): DeviceActivationResult {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/device-enrollments/activate', raw);
  const token = pickString(data, 'token', 'accessToken', 'deviceToken', 'apiKey', 'terminalKey');
  if (!token) throw new ContractError('/api/device-enrollments/activate — jeton', raw);
  return {
    token,
    siteId: pickString(data, 'siteId', 'site'),
    siteLabel: pickString(data, 'siteLabel', 'siteName', 'label'),
  };
}

export interface ShiftStartResult {
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
    token: pickString(data, 'token', 'accessToken', 'jwt'),
    matricule: pickString(agent, 'matricule', 'badge', 'agentId') ?? fallbackMatricule,
    nom: pickString(agent, 'nom', 'name', 'displayName', 'fullName'),
    shiftId: pickString(data, 'shiftId', 'id', 'posteId'),
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
  const checkpoints = pickArray(data, 'postes', 'checkpoints', 'points')
    .map(parseSiteRef)
    .filter((site): site is SiteRef => site !== null);
  return {
    siteLabel: pickString(data, 'siteLabel', 'label', 'nom', 'name'),
    checkpoints,
  };
}

export interface ExpectedVisit {
  visitId: string;
  nom: string;
  mode: AccessMode;
  statut: VisitStatus;
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
  jws?: string;
  visits: ExpectedVisit[];
  expiresAt?: number;
}

// La liste arrive soit en JWS compact brut, soit enveloppée dans un objet JSON.
function parseOfflineListEnvelope(raw: unknown): { jws?: string; payload: unknown } {
  if (typeof raw === 'string') return { jws: raw, payload: undefined };
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/agent/offline-list', raw);
  const jws = pickString(data, 'jws', 'token', 'signedList', 'payload', 'signedPayload');
  if (jws && jws.split('.').length === 3) return { jws, payload: undefined };
  return { jws: undefined, payload: data };
}

export function parseOfflineListPayload(raw: unknown, jws?: string): OfflineList {
  const data = asObject(raw);
  if (!data) throw new ContractError('/api/agent/offline-list — charge utile', raw);
  return {
    jws,
    visits: parseExpectedVisits(data),
    expiresAt: pickDate(data, 'expiresAtUtc', 'expiresAt'),
  };
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

  async agentSites(): Promise<SiteRef[]> {
    return parseSites(await request<unknown>('GET', '/api/agent/sites'));
  },

  async siteConfig(): Promise<SiteConfig> {
    return parseSiteConfig(await request<unknown>('GET', '/api/site/config'));
  },

  async shiftStart(matricule: string, pin: string): Promise<ShiftStartResult> {
    const raw = await request<unknown>('POST', '/api/agent/shift/start', { matricule, pin });
    return parseShiftStart(raw, matricule);
  },

  async expectedToday(): Promise<ExpectedVisit[]> {
    return parseExpectedVisits(await request<unknown>('GET', '/api/agent/expected-today'));
  },

  async offlineList(): Promise<{ jws?: string; payload: unknown }> {
    return parseOfflineListEnvelope(await request<unknown>('GET', '/api/agent/offline-list'));
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

  async resync(scans: OfflineScanPayload[]): Promise<ResyncResult> {
    const raw = await request<unknown>('POST', '/api/agent/resync', { scans });
    return parseResync(raw, scans.length);
  },
};
