import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { allPublicKeys, publicKeyFor } from '@/features/auth/enrollment.store';
import { useAuthStore } from '@/features/auth/auth.store';
import {
  NetworkError,
  api,
  errorMessage,
  parseOfflineListPayload,
  toApiDirection,
  type OfflineScanPayload,
  type ScanResult,
} from '@/lib/api';
import { readJwsHeader, verifyJws } from '@/lib/crypto';
import {
  decideInvalidSignature,
  decideListExpired,
  decideNotInList,
  decideOffline,
  type ScanContext,
  type ScanDecision,
} from '@/features/scan/engine';
import { getItem, setItem } from '@/lib/storage';
import { durSince, fmtDur } from '@/lib/time';
import type {
  Direction,
  JournalEntry,
  OfflineVisit,
  PendingScan,
  Verdict,
  VerdictCode,
} from '@/types/domain';

const OFFLINE_LIST_KEY = 'novacces.offline-list';
const PENDING_SCANS_KEY = 'novacces.pending-scans';

const DENIAL_LABELS: Partial<Record<VerdictCode, { title: string; reason: string }>> = {
  INVALID_SIGNATURE: { title: 'QR INVALIDE', reason: 'SIGNATURE INVALIDE — QR ALTÉRÉ' },
  DENIED_Excluded: { title: 'ACCÈS REFUSÉ', reason: 'VOIR POSTE DE GARDE' },
  DENIED_SuspectedDuplicate: { title: 'DÉJÀ SUR SITE', reason: 'SUSPICION DE COPIE — VOIR POSTE DE GARDE' },
  DENIED_CycleAlreadyClosed: { title: 'ACCÈS REFUSÉ', reason: 'CYCLE ENTRÉE/SORTIE CLOS' },
  DENIED_AlreadyConsumed: { title: 'ACCÈS REFUSÉ', reason: 'QR DÉJÀ CONSOMMÉ — ANTI-REJEU' },
  DENIED_TooEarly: { title: 'ACCÈS REFUSÉ', reason: 'TROP TÔT — HORS FENÊTRE' },
  DENIED_TooLate: { title: 'ACCÈS REFUSÉ', reason: 'HORS FENÊTRE DE VALIDITÉ' },
  DENIED_NonBusinessDay: { title: 'ACCÈS REFUSÉ', reason: 'JOUR NON OUVRÉ' },
  DENIED_Revoked: { title: 'ACCÈS REFUSÉ', reason: 'QR RÉVOQUÉ PAR LA SÛRETÉ' },
  DENIED_NoActiveEntry: { title: 'AUCUNE ENTRÉE ENREGISTRÉE', reason: 'SORTIE IMPOSSIBLE' },
};

// Un verdictCode inconnu est présenté comme un refus, jamais comme une autorisation.
function verdictFromServer(result: ScanResult): Verdict {
  const who = result.visitorName ?? 'Visiteur';

  if (result.isCheckOut) {
    const overstay =
      result.overstayMinutes && result.overstayMinutes > 0
        ? ` · dépassement +${fmtDur(result.overstayMinutes)}`
        : ' · bonne route';
    return {
      kind: 'out',
      code: 'CHECKED_OUT',
      title: 'SORTIE ENREGISTRÉE',
      who,
      detail: `Sortie enregistrée${overstay}`,
      degraded: false,
      securityEvent: result.isSecurityEvent,
    };
  }

  if (result.isGranted) {
    return {
      kind: 'ok',
      code: result.verdictCode,
      title: 'ACCÈS AUTORISÉ',
      who,
      detail: 'Entrée enregistrée par le serveur central',
      degraded: false,
      securityEvent: result.isSecurityEvent,
    };
  }

  const label = DENIAL_LABELS[result.verdictCode];
  return {
    kind: 'no',
    code: result.verdictCode,
    title: label?.title ?? 'ACCÈS REFUSÉ',
    who,
    detail: 'Diriger le visiteur vers le poste de garde',
    reason: label?.reason ?? result.verdictCode,
    degraded: false,
    securityEvent: result.isSecurityEvent,
  };
}

// Incident technique — présenté comme tel, pas comme un refus d'accès.
function verdictFromFailure(detail: string): Verdict {
  return {
    kind: 'no',
    code: 'SERVER_ERROR',
    title: 'VÉRIFICATION IMPOSSIBLE',
    who: 'Contrôle non abouti',
    detail,
    reason: 'ERREUR SERVEUR',
    degraded: false,
    securityEvent: false,
  };
}

function visitIdFromPayload(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const key of ['visitId', 'visitToken', 'vid', 'sub', 'jti']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

interface ScanState {
  visits: OfflineVisit[];
  journal: JournalEntry[];
  scansToday: number;
  direction: Direction;
  degraded: boolean;
  ttlExpired: boolean;
  offlineListExpiresAt: number | null;
  pending: PendingScan[];
  haptics: boolean;
  verdict: Verdict | null;
  lastSync: string | null;
  busy: boolean;

  hydrate: () => Promise<void>;
  scanPayload: (payload: string) => Promise<void>;
  closeVerdict: () => void;
  toggleDirection: () => void;
  toggleHaptics: () => void;
  checkConnectivity: () => Promise<void>;
  refreshDayList: () => Promise<void>;
  resync: () => Promise<void>;
  reset: () => void;
}

function feedback(kind: Verdict['kind'], enabled: boolean) {
  if (!enabled) return;
  if (kind === 'ok') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  else if (kind === 'out') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

export const useScanStore = create<ScanState>((set, get) => ({
  visits: [],
  journal: [],
  scansToday: 0,
  direction: 'entree',
  degraded: false,
  ttlExpired: false,
  offlineListExpiresAt: null,
  pending: [],
  haptics: true,
  verdict: null,
  lastSync: null,
  busy: false,

  hydrate: async () => {
    const [rawList, rawPending] = await Promise.all([
      getItem(OFFLINE_LIST_KEY),
      getItem(PENDING_SCANS_KEY),
    ]);
    try {
      if (rawList) {
        const cached = JSON.parse(rawList) as { visits: OfflineVisit[]; expiresAt: number | null };
        set({
          visits: cached.visits ?? [],
          offlineListExpiresAt: cached.expiresAt ?? null,
          ttlExpired: cached.expiresAt ? Date.now() > cached.expiresAt : false,
        });
      }
      if (rawPending) set({ pending: JSON.parse(rawPending) as PendingScan[] });
    } catch {
      // cache illisible : régénéré au prochain rafraîchissement
    }
  },

  scanPayload: async (payload) => {
    const state = get();
    if (state.busy || state.verdict) return;

    const { agent, post } = useAuthStore.getState();
    const agentId = agent?.matricule ?? '—';
    const ctx: ScanContext = {
      direction: state.direction,
      ttlExpired: state.ttlExpired,
      agentId,
      now: Date.now(),
    };

    if (!state.degraded) {
      set({ busy: true });
      try {
        const result = await api.scan(payload, state.direction, agentId, post?.checkpointId ?? '');
        const verdict = verdictFromServer(result);
        feedback(verdict.kind, state.haptics);
        set((s) => ({
          busy: false,
          verdict,
          scansToday: s.scansToday + 1,
          journal: [
            {
              t: ctx.now,
              nom: result.visitorName ?? 'Visiteur',
              agent: agentId,
              ok: result.isGranted || result.isCheckOut,
              out: result.isCheckOut,
              det: `${result.verdictCode}${result.overstayMinutes ? ` · dépassement +${fmtDur(result.overstayMinutes)}` : ''}`,
              deg: false,
              sec: result.isSecurityEvent,
            },
            ...s.journal,
          ],
        }));
        return;
      } catch (err) {
        if (err instanceof NetworkError) {
          // bascule en dégradé, le même scan est repris hors ligne ci-dessous
          set({ busy: false, degraded: true });
        } else {
          const verdict = verdictFromFailure(errorMessage(err));
          feedback('no', state.haptics);
          set((s) => ({
            busy: false,
            verdict,
            journal: [
              {
                t: ctx.now, nom: 'Contrôle non abouti', agent: agentId, ok: false,
                det: `Échec du contrôle serveur : ${errorMessage(err)}`, deg: false, sec: false,
              },
              ...s.journal,
            ],
          }));
          return;
        }
      }
    }

    // Mode dégradé : la signature se vérifie sans serveur, un QR forgé reste
    // rejeté pendant une coupure.
    const current = get();

    const kid = readJwsHeader(payload)?.kid;
    const candidates = publicKeyFor(kid) ? [publicKeyFor(kid) as string] : allPublicKeys();
    let claims: Record<string, unknown> | null = null;
    for (const pem of candidates) {
      claims = verifyJws<Record<string, unknown>>(payload, pem);
      if (claims) break;
    }

    let decision: ScanDecision;
    if (!claims) {
      decision = decideInvalidSignature(ctx);
    } else if (current.ttlExpired) {
      decision = decideListExpired(ctx);
    } else {
      const visitId = visitIdFromPayload(claims);
      const visit = current.visits.find((v) => v.visitId === visitId);
      decision = visit ? decideOffline(visit, ctx) : decideNotInList(ctx);

      if (visit && Object.keys(decision.patch).length > 0) {
        const patched = current.visits.map((v) =>
          v.visitId === visit.visitId ? { ...v, ...decision.patch } : v,
        );
        set({ visits: patched });
        void setItem(
          OFFLINE_LIST_KEY,
          JSON.stringify({ visits: patched, expiresAt: current.offlineListExpiresAt }),
        );
      }

      if (visit && decision.verdict.kind !== 'no') {
        const pending: PendingScan[] = [
          ...current.pending,
          {
            visitId: visit.visitId,
            signedQrPayload: payload,
            direction: current.direction,
            wasGranted: decision.verdict.kind === 'ok',
            occurredAt: ctx.now,
            verdictCode: decision.verdict.code,
            wasSecurityEvent: decision.verdict.securityEvent,
          },
        ];
        set({ pending });
        void setItem(PENDING_SCANS_KEY, JSON.stringify(pending));
      }
    }

    feedback(decision.verdict.kind, current.haptics);
    set((s) => ({
      verdict: decision.verdict,
      scansToday: s.scansToday + 1,
      journal: [decision.journal, ...s.journal],
    }));
  },

  closeVerdict: () => set({ verdict: null }),

  toggleDirection: () =>
    set((s) => ({ direction: s.direction === 'entree' ? 'sortie' : 'entree' })),

  toggleHaptics: () => set((s) => ({ haptics: !s.haptics })),

  checkConnectivity: async () => {
    try {
      await api.health();
      if (get().degraded) {
        set({ degraded: false });
        await get().resync();
        await get().refreshDayList();
      }
    } catch {
      if (!get().degraded) set({ degraded: true });
    }
  },

  refreshDayList: async () => {
    const now = Date.now();
    try {
      const envelope = await api.offlineList();
      let payload: unknown = envelope.payload;

      if (envelope.jws) {
        const kid = readJwsHeader(envelope.jws)?.kid;
        const candidates = publicKeyFor(kid) ? [publicKeyFor(kid) as string] : allPublicKeys();
        payload = null;
        for (const pem of candidates) {
          payload = verifyJws<unknown>(envelope.jws, pem);
          if (payload) break;
        }
        if (!payload) {
          // liste non vérifiable : on garde l'ancienne, le TTL fera foi
          set({ lastSync: 'Liste du jour rejetée : signature non vérifiable' });
          return;
        }
      }

      const list = parseOfflineListPayload(payload, envelope.jws);
      const expiresAt = list.expiresAt ?? now + 4 * 3_600_000;
      const visits: OfflineVisit[] = list.visits.map((v) => ({
        visitId: v.visitId,
        nom: v.nom,
        mode: v.mode,
        statut: v.statut,
        fenetreDebut: v.fenetreDebut,
        fenetreFin: v.fenetreFin,
        present: v.present,
      }));
      set({ visits, offlineListExpiresAt: expiresAt, ttlExpired: now > expiresAt });
      await setItem(OFFLINE_LIST_KEY, JSON.stringify({ visits, expiresAt }));
    } catch (err) {
      if (err instanceof NetworkError) {
        set({ degraded: true });
        return;
      }
      // repli : les attendus alimentent au moins l'écran de recherche
      try {
        const expected = await api.expectedToday();
        set({
          visits: expected.map((v) => ({
            visitId: v.visitId, nom: v.nom, mode: v.mode, statut: v.statut,
            fenetreDebut: v.fenetreDebut, fenetreFin: v.fenetreFin, present: v.present,
          })),
        });
      } catch {
        // l'écran « Attendus » restera vide, sans conséquence sur le scan
      }
    }
  },

  resync: async () => {
    const pending = get().pending;
    if (pending.length === 0) return;

    const payload: OfflineScanPayload[] = pending.map((p) => ({
      visitToken: p.visitId,
      direction: toApiDirection(p.direction),
      wasGranted: p.wasGranted,
      occurredAt: new Date(p.occurredAt).toISOString(),
      verdictCode: p.verdictCode,
      wasSecurityEvent: p.wasSecurityEvent,
      signedQrPayload: p.signedQrPayload,
    }));

    try {
      const result = await api.resync(payload);
      const conflicts: JournalEntry[] = result.conflicts.map((c) => ({
        t: Date.now(),
        nom: pending.find((p) => p.visitId === c.visitId)?.visitId ?? 'Visite',
        agent: 'SYNC',
        ok: false,
        det: `CONFLIT à la resynchronisation : ${c.raison} — remonté au responsable sûreté`,
        deg: false,
        sec: true,
      }));
      set((s) => ({
        pending: [],
        journal: [...conflicts, ...s.journal],
        lastSync:
          result.conflicts.length > 0
            ? `Resync : ${result.conflicts.length} conflit(s) remonté(s) en événement de sécurité`
            : `Resync : ${result.accepted} validation(s) hors ligne, aucun conflit`,
      }));
      await setItem(PENDING_SCANS_KEY, JSON.stringify([]));
    } catch (err) {
      // les scans restent en file, ils ne doivent jamais être perdus
      set({ lastSync: `Resynchronisation impossible : ${errorMessage(err)}` });
    }
  },

  reset: () =>
    set({
      visits: [], journal: [], scansToday: 0, direction: 'entree', degraded: false,
      ttlExpired: false, offlineListExpiresAt: null, pending: [], verdict: null, lastSync: null,
    }),
}));

export function ttlLabel(expiresAt: number | null, expired: boolean): string {
  if (expired || !expiresAt) return 'EXPIRÉ';
  if (Date.now() >= expiresAt) return 'EXPIRÉ';
  return durSince(Date.now(), expiresAt);
}
