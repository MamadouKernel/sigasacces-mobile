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
/** La clé privée du terminal est stockée à part : elle ne doit jamais transiter. */
const DEVICE_KEY = 'novacces.device-private-key';

/**
 * Enrôlement du TERMINAL (l'appareil), distinct de la session de l'AGENT.
 *
 * Réalisé une seule fois à la mise en service : l'Admin génère un ticket QR
 * temporaire à usage unique (`POST /api/admin/terminals/{id}/enrollment-ticket`),
 * le terminal génère sur place une paire de clés ES256, prouve qu'il en détient
 * la privée, et reçoit en retour son jeton d'appareil. La clé privée ne quitte
 * jamais le Keystore/Keychain ; un terminal volé se révoque côté serveur
 * (`POST /api/admin/terminals/{id}/revoke`) sans toucher aux comptes agents.
 */
export interface StoredEnrollment {
  /** Identifiant d'instance de l'appareil (GUID), lié à la paire de clés. */
  deviceInstanceId: string;
  publicKeyPem: string;
  /** Jeton d'appareil délivré par l'API à l'activation. */
  deviceToken: string;
  baseUrl: string;
  siteId?: string;
  siteLabel?: string;
  /** Clés publiques ES256 du serveur, par `kid` (vérification hors ligne). */
  publicKeys: Record<string, string>;
}

/**
 * CONTRAT À CONFIRMER — preuve de possession de la clé du device.
 *
 * Le contrat OpenAPI déclare le champ `proofSignature` sans préciser ce qu'il
 * couvre ni son encodage. Cinq hypothèses ont été testées contre l'API de
 * production (`ticket`, `deviceInstanceId`, et leurs concaténations, en DER
 * base64 comme en P1363 base64url) : toutes sont rejetées. Le message signé
 * est donc défini côté serveur d'une façon non publiée — probablement un
 * aléa (nonce) porté par le ticket.
 *
 * Tant que la spécification n'est pas fournie, l'activation échouera avec le
 * message du serveur. Le jour où elle l'est, seules ces deux fonctions sont à
 * corriger.
 */
function buildProofMessage(ticket: string, deviceInstanceId: string): string {
  return `${ticket}.${deviceInstanceId}`;
}

function encodeProof(signature: Uint8Array): string {
  return bytesToBase64(signature);
}

/**
 * Contenu du QR d'enrôlement. Le ticket peut être présenté seul (chaîne brute)
 * ou enveloppé dans un JSON précisant le serveur du site, ce qui permet de
 * déployer un même binaire sur plusieurs installations.
 */
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
  /** Lecture du stockage sécurisé terminée (évite un flash de redirection). */
  hydrated: boolean;
  enrollment: StoredEnrollment | null;
  busy: boolean;
  hydrate: () => Promise<void>;
  /** Active le terminal auprès du serveur avec un ticket QR à usage unique. */
  activate: (ticket: string, baseUrl?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Rafraîchit les clés publiques ES256 (rotation sans republier l'app). */
  refreshPublicKeys: () => Promise<void>;
  /** Désenrôlement : oublie le jeton, la clé privée et le site. */
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

      // La paire de clés est régénérée à chaque enrôlement : un terminal
      // réenrôlé est une nouvelle identité, l'ancienne restant révocable.
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

      // Les clés de vérification hors ligne sont récupérées immédiatement :
      // sans elles, le mode dégradé ne pourrait rien valider.
      let publicKeys: Record<string, string> = {};
      try {
        publicKeys = (await api.publicKeys()).keys;
      } catch {
        /* récupérables plus tard : ne bloque pas la mise en service */
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
      // Sans source d'entropie sûre, l'identité de l'appareil serait forgeable :
      // l'enrôlement est refusé plutôt que dégradé.
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
      /* rotation sans conséquence immédiate : les clés connues restent valides */
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

/** Clé publique associée au `kid` porté par un QR ou une liste signée. */
export function publicKeyFor(kid: string | undefined): string | null {
  const keys = useEnrollmentStore.getState().enrollment?.publicKeys ?? {};
  if (kid && keys[kid]) return keys[kid];
  // Sans `kid`, un seul jeu de clés est en circulation dans l'immense majorité
  // des cas : la première connue est alors la bonne.
  const values = Object.values(keys);
  return values.length === 1 ? values[0] : null;
}

/** Toutes les clés publiques connues — pour tenter la vérification sur chacune. */
export function allPublicKeys(): string[] {
  return Object.values(useEnrollmentStore.getState().enrollment?.publicKeys ?? {});
}
