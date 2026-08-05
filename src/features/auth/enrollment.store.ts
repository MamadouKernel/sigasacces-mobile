import { create } from 'zustand';

import {
  ApiError,
  NetworkError,
  api,
  setBaseUrl,
  setDeviceToken,
  setSiteId,
  apiConfig,
} from '@/lib/api';
import {
  SecureRandomUnavailableError,
  bytesToBase64,
  generateDeviceKeyPair,
  randomUuid,
  signWithDeviceKey,
} from '@/lib/crypto';
import { deleteItem, getItem, setItem } from '@/lib/storage';

const ENROLLMENT_KEY = 'novacces.enrollment';
// Clé privée stockée à part : elle ne doit jamais transiter.
const DEVICE_KEY = 'novacces.device-private-key';

export interface StoredEnrollment {
  deviceInstanceId: string;
  publicKeyPem: string;
  deviceToken: string;
  baseUrl: string;
  siteId?: string;
  siteLabel?: string;
  /** Clés publiques ES256 du serveur, par `kid` (vérification hors ligne). */
  publicKeys: Record<string, string>;
}

// CONTRAT À CONFIRMER : message couvert par proofSignature et son encodage.
// Cinq hypothèses testées contre la prod, toutes rejetées (voir
// docs/besoins-api-app-agent.md §Q1). Seules ces deux fonctions sont à
// corriger quand la spec arrivera.
function buildProofMessage(ticket: string, deviceInstanceId: string): string {
  return `${ticket}.${deviceInstanceId}`;
}

function encodeProof(signature: Uint8Array): string {
  return bytesToBase64(signature);
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
      setDeviceToken(enrollment.deviceToken);
      setSiteId(enrollment.siteId ?? null);
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

      setDeviceToken(activation.token);
      setSiteId(activation.siteId ?? null);

      // Sans les clés publiques, le mode dégradé ne peut rien valider.
      let publicKeys: Record<string, string> = {};
      try {
        publicKeys = (await api.publicKeys()).keys;
      } catch {
        // récupérables plus tard, ne bloque pas la mise en service
      }

      const enrollment: StoredEnrollment = {
        deviceInstanceId,
        publicKeyPem,
        deviceToken: activation.token,
        baseUrl: apiConfig.baseUrl,
        siteId: activation.siteId,
        siteLabel: activation.siteLabel,
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
      const { keys } = await api.publicKeys();
      const enrollment = { ...current, publicKeys: { ...current.publicKeys, ...keys } };
      set({ enrollment });
      await setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
    } catch {
      // les clés déjà connues restent valides
    }
  },

  reset: async () => {
    setDeviceToken(null);
    setSiteId(null);
    set({ enrollment: null });
    await deleteItem(ENROLLMENT_KEY);
    await deleteItem(DEVICE_KEY);
  },
}));

export function publicKeyFor(kid: string | undefined): string | null {
  const keys = useEnrollmentStore.getState().enrollment?.publicKeys ?? {};
  if (kid && keys[kid]) return keys[kid];
  const values = Object.values(keys);
  return values.length === 1 ? values[0] : null;
}

export function allPublicKeys(): string[] {
  return Object.values(useEnrollmentStore.getState().enrollment?.publicKeys ?? {});
}
