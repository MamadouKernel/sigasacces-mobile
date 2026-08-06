import { create } from 'zustand';

import {
  ApiError,
  NetworkError,
  api,
  setApiKey,
  setBaseUrl,
  setSiteId,
  apiConfig,
} from '@/lib/api';
import {
  SecureRandomUnavailableError,
  bytesToBase64Url,
  generateDeviceKeyPair,
  randomUuid,
  signWithDeviceKey,
} from '@/lib/crypto';
import { deleteItem, getItem, setItem } from '@/lib/storage';

// Suffixe de version : un enrôlement écrit avant la spec du 05/08/2026 portait
// un jeton Bearer là où le serveur attend une clé X-Api-Key. Le relire mènerait
// à des 401 en boucle — mieux vaut forcer un réenrôlement.
const ENROLLMENT_KEY = 'novacces.enrollment.v2';
// Clé privée stockée à part : elle ne doit jamais transiter.
const DEVICE_KEY = 'novacces.device-private-key.v2';

export interface StoredEnrollment {
  deviceInstanceId: string;
  publicKeyPem: string;
  /** Secret opaque du terminal, envoyé en X-Api-Key sur chaque requête. */
  apiKey: string;
  baseUrl: string;
  terminalLabel?: string;
  /** Sites autorisés ; une seule entrée = terminal mono-site. */
  siteIds: string[];
  /** Clés publiques ES256 du serveur, par `kid` (vérification hors ligne). */
  publicKeys: Record<string, string>;
}

// Message vérifié côté serveur : UTF8.GetBytes($"{ticket}|{deviceInstanceId}"),
// signé en ES256 P1363 puis encodé en Base64URL (DeviceEnrollmentEndpoints.cs).
function buildProofMessage(ticket: string, deviceInstanceId: string): string {
  return `${ticket}|${deviceInstanceId}`;
}

function encodeProof(signature: Uint8Array): string {
  return bytesToBase64Url(signature);
}

// Le ticket est soit une chaîne brute, soit un JSON { ticket, baseUrl } qui
// permet de pointer un même binaire vers plusieurs installations.
export function parseEnrollmentTicket(
  raw: string,
): { ok: true; ticket: string; baseUrl?: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'QR vide.' };

  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const ticket = typeof data.ticket === 'string' ? data.ticket.trim() : '';
      const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl.trim() : undefined;
      if (!ticket) return { ok: false, error: "Ce QR ne contient pas de ticket d'enrôlement." };
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
        return { ok: false, error: "L'URL du serveur doit commencer par http(s)://." };
      }
      return { ok: true, ticket, baseUrl };
    } catch {
      return { ok: false, error: 'QR de configuration illisible (JSON invalide).' };
    }
  }
  return { ok: true, ticket: text };
}

interface EnrollmentState {
  hydrated: boolean;
  enrollment: StoredEnrollment | null;
  busy: boolean;
  hydrate: () => Promise<void>;
  activate: (ticket: string, baseUrl?: string) => Promise<{ ok: boolean; error?: string }>;
  refreshPublicKeys: () => Promise<void>;
  reset: () => Promise<void>;
}

export const useEnrollmentStore = create<EnrollmentState>((set, get) => ({
  hydrated: false,
  enrollment: null,
  busy: false,

  hydrate: async () => {
    const raw = await getItem(ENROLLMENT_KEY);
    let enrollment: StoredEnrollment | null = null;
    if (raw) {
      try {
        enrollment = JSON.parse(raw) as StoredEnrollment;
      } catch {
        await deleteItem(ENROLLMENT_KEY);
      }
    }
    if (enrollment) {
      setBaseUrl(enrollment.baseUrl);
      setApiKey(enrollment.apiKey);
      setSiteId(soleSiteId(enrollment));
    }
    set({ enrollment, hydrated: true });
  },

  activate: async (ticket, baseUrl) => {
    if (get().busy) return { ok: false, error: 'Activation déjà en cours.' };
    set({ busy: true });
    try {
      if (baseUrl) setBaseUrl(baseUrl);

      // Paire régénérée à chaque enrôlement : un terminal réenrôlé est une
      // nouvelle identité, l'ancienne reste révocable.
      const deviceInstanceId = randomUuid();
      const { privateKeyHex, publicKeyPem } = generateDeviceKeyPair();
      const proofSignature = encodeProof(
        signWithDeviceKey(privateKeyHex, buildProofMessage(ticket, deviceInstanceId)),
      );

      const activation = await api.activateDevice({
        ticket,
        deviceInstanceId,
        devicePublicKeyPem: publicKeyPem,
        proofSignature,
      });

      setApiKey(activation.apiKey);
      setSiteId(activation.siteIds.length === 1 ? activation.siteIds[0] : null);

      // Sans les clés publiques, le mode dégradé ne peut rien valider ; elles
      // restent récupérables plus tard, l'échec ne bloque pas la mise en service.
      let publicKeys: Record<string, string> = {};
      try {
        publicKeys = await api.publicKeys();
      } catch {
        publicKeys = {};
      }

      const enrollment: StoredEnrollment = {
        deviceInstanceId,
        publicKeyPem,
        apiKey: activation.apiKey,
        baseUrl: apiConfig.baseUrl,
        terminalLabel: activation.label,
        siteIds: activation.siteIds,
        publicKeys,
      };

      await setItem(DEVICE_KEY, privateKeyHex);
      await setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
      set({ enrollment, busy: false });
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      if (err instanceof SecureRandomUnavailableError) return { ok: false, error: err.message };
      if (err instanceof NetworkError) {
        return { ok: false, error: 'Serveur injoignable — vérifiez le réseau du terminal.' };
      }
      if (err instanceof ApiError) return { ok: false, error: err.message };
      return { ok: false, error: (err as Error).message };
    }
  },

  refreshPublicKeys: async () => {
    const current = get().enrollment;
    if (!current) return;
    try {
      const keys = await api.publicKeys();
      const enrollment = { ...current, publicKeys: { ...current.publicKeys, ...keys } };
      set({ enrollment });
      await setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
    } catch {
      // les clés déjà connues restent valides
    }
  },

  reset: async () => {
    setApiKey(null);
    setSiteId(null);
    set({ enrollment: null });
    await deleteItem(ENROLLMENT_KEY);
    await deleteItem(DEVICE_KEY);
  },
}));

/** Site implicite d'un terminal mono-site ; `null` dès qu'il y a un choix à faire. */
export function soleSiteId(enrollment: StoredEnrollment | null): string | null {
  return enrollment?.siteIds.length === 1 ? enrollment.siteIds[0] : null;
}

export function publicKeyFor(kid: string | undefined): string | null {
  const keys = useEnrollmentStore.getState().enrollment?.publicKeys ?? {};
  if (kid && keys[kid]) return keys[kid];
  const values = Object.values(keys);
  return values.length === 1 ? values[0] : null;
}

export function allPublicKeys(): string[] {
  return Object.values(useEnrollmentStore.getState().enrollment?.publicKeys ?? {});
}
