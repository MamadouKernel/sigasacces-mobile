import * as Haptics from 'expo-haptics';
import { create } from 'zustand';

import { allPublicKeys, publicKeyFor } from '@/features/auth/enrollment.store';
import { useAuthStore } from '@/features/auth/auth.store';
import {
  NetworkError,
  api,
  errorMessage,
  parseQrClaims,
  parseSignedVisits,
  toApiDirection,
  type OfflineScanPayload,
  type ScanResult,
} from '@/lib/api';
import { computeManualCodeHash, parseSignedEnvelope, verifySignedEnvelope, type SignedEnvelope } from '@/lib/crypto';
import {
  decideExpiredQr,
  decideInvalidSignature,
  decideListExpired,
  decideManualCodeListExpired,
  decideManualCodeNotFound,
  decideNotInList,
  decideOffline,
  type ScanContext,
  type ScanDecision,
} from '@/features/scan/engine';
import { getItem, setItem } from '@/lib/storage';
import { playOverstayBeep } from '@/lib/sound';
import { durSince, fmtDur } from '@/lib/time';
import type {
  Direction,
  JournalEntry,
  OfflineVisit,
  PendingScan,
  Verdict,
  VerdictCode,
} from '@/types/domain';

// Suffixe de version : le schéma des deux caches a changé avec la spec du
// 05/08/2026, une entrée écrite avant serait relue de travers.
const OFFLINE_LIST_KEY = 'sigasacces.offline-list.v2';
const PENDING_SCANS_KEY = 'sigasacces.pending-scans.v2';

const DENIAL_LABELS: Partial<Record<VerdictCode, { title: string; reason: string }>> = {
  INVALID_SIGNATURE: { title: 'QR INVALIDE', reason: 'SIGNATURE INVALIDE — QR ALTÉRÉ' },
  INVALID_CODE: { title: 'CODE INCONNU', reason: 'VÉRIFIEZ LA SAISIE AUPRÈS DU VISITEUR' },
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

// Un `keyId` inconnu ne disqualifie pas l'enveloppe : on retombe sur l'ensemble
// des clés connues, la signature restant seule juge.
function verifyWithKnownKeys<T>(envelope: SignedEnvelope): T | null {
  const named = publicKeyFor(envelope.keyId);
  for (const pem of named ? [named] : allPublicKeys()) {
    const payload = verifySignedEnvelope<T>(envelope, pem);
    if (payload) return payload;
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
  // Visites avec une demande de confirmation sûreté en attente (tap
  // « Attendus » sans QR/code) — visitId -> expiration (miroir du délai
  // serveur, 15 min). État local uniquement, jamais persisté : purgé à
  // l'expiration ou dès que la visite passe présente/sortie (issue réelle
  // constatée) lors d'un rafraîchissement de la liste.
  pendingConfirmations: Map<string, number>;
  haptics: boolean;
  verdict: Verdict | null;
  lastSync: string | null;
  busy: boolean;

  hydrate: () => Promise<void>;
  scanPayload: (payload: string) => Promise<void>;
  scanManualCode: (code: string) => Promise<void>;
  requestConfirmation: (visit: OfflineVisit) => Promise<{ ok: boolean; error?: string }>;
  closeVerdict: () => void;
  toggleDirection: () => void;
  toggleHaptics: () => void;
  checkConnectivity: () => Promise<void>;
  refreshDayList: () => Promise<void>;
  notifyOverstay: (visits: OfflineVisit[]) => Promise<void>;
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
  pendingConfirmations: new Map<string, number>(),
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
        // La liste "Attendus" (visits) n'est PAS mise à jour par ce scan --
        // seuls verdict/journal le sont ci-dessus. Sans ce rafraîchissement,
        // un visiteur qui vient d'entrer/sortir garde son statut d'AVANT le
        // scan dans la liste (jusqu'au prochain cycle de 15 min), affichant
        // par ex. "NON VENU" pour quelqu'un qui vient d'être scanné avec
        // succès. Non bloquant : ne retarde jamais l'affichage du verdict.
        if (result.isGranted || result.isCheckOut) void get().refreshDayList();
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

    const envelope = parseSignedEnvelope(payload);
    const claims = envelope ? parseQrClaims(verifyWithKnownKeys(envelope)) : null;

    let decision: ScanDecision;
    if (!claims) {
      decision = decideInvalidSignature(ctx);
    } else if (claims.exp !== undefined && ctx.now >= claims.exp * 1000) {
      decision = decideExpiredQr(ctx);
    } else if (current.ttlExpired) {
      decision = decideListExpired(ctx);
    } else {
      const visit = current.visits.find((v) => v.visitId === claims.visitId);
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
            signedQrPayload: payload,
            direction: current.direction,
            agentId,
            occurredAt: ctx.now,
            offlineVerdict: decision.verdict.code,
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

  // Code de secours (alternative au QR, saisi par l'agent — ManualCodeSheet).
  // Route et logique dédiées : appeler scanPayload() enverrait le code tapé
  // à /api/scan comme si c'était un QR signé, échec systématique en
  // INVALID_SIGNATURE. Repli hors ligne ajouté le 09/08/2026 : l'empreinte
  // PBKDF2 durcie du code (voir crypto.ts, computeManualCodeHash) voyage
  // désormais dans la liste signée du jour (OfflineVisit.manualCodeHash) —
  // la vérification locale devient possible EXACTEMENT comme pour le QR, en
  // réutilisant le même moteur de décision (engine.ts, decideOffline).
  scanManualCode: async (code) => {
    const state = get();
    if (state.busy || state.verdict) return;

    const { agent, post } = useAuthStore.getState();
    const agentId = agent?.matricule ?? '—';
    const now = Date.now();

    if (state.degraded) {
      const ctx: ScanContext = { direction: state.direction, ttlExpired: state.ttlExpired, agentId, now };
      const current = get();

      let decision: ScanDecision;
      if (current.ttlExpired) {
        decision = decideManualCodeListExpired(ctx);
      } else {
        const hash = await computeManualCodeHash(code);
        const visit = current.visits.find((v) => v.manualCodeHash && v.manualCodeHash === hash);
        decision = visit ? decideOffline(visit, ctx) : decideManualCodeNotFound(ctx);

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
              signedQrPayload: '',
              manualCode: code,
              direction: current.direction,
              agentId,
              occurredAt: now,
              offlineVerdict: decision.verdict.code,
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
      return;
    }

    set({ busy: true });
    try {
      const result = await api.scanManualCode(code, state.direction, post?.checkpointId ?? '');
      const verdict = verdictFromServer(result);
      feedback(verdict.kind, state.haptics);
      set((s) => ({
        busy: false,
        verdict,
        scansToday: s.scansToday + 1,
        journal: [
          {
            t: now,
            nom: result.visitorName ?? 'Visiteur',
            agent: agentId,
            ok: result.isGranted || result.isCheckOut,
            out: result.isCheckOut,
            det: `${result.verdictCode} · code de secours${result.overstayMinutes ? ` · dépassement +${fmtDur(result.overstayMinutes)}` : ''}`,
            deg: false,
            sec: result.isSecurityEvent,
          },
          ...s.journal,
        ],
      }));
      // Même raison que dans scanPayload : sans ça, la liste "Attendus" garde
      // le statut d'avant ce scan.
      if (result.isGranted || result.isCheckOut) void get().refreshDayList();
    } catch (err) {
      if (err instanceof NetworkError) {
        const verdict: Verdict = {
          kind: 'no',
          code: 'SERVER_ERROR',
          title: 'SERVICE INDISPONIBLE',
          who: 'Code de secours',
          detail: 'Réessayez dans un instant.',
          reason: 'CONNEXION REQUISE',
          degraded: true,
          securityEvent: false,
        };
        feedback('no', state.haptics);
        set((s) => ({
          busy: false,
          degraded: true,
          verdict,
          scansToday: s.scansToday + 1,
          journal: [
            { t: now, nom: 'Code de secours', agent: agentId, ok: false, det: 'Panne réseau pendant la vérification', deg: true, sec: false },
            ...s.journal,
          ],
        }));
      } else {
        const verdict = verdictFromFailure(errorMessage(err));
        feedback('no', state.haptics);
        set((s) => ({
          busy: false,
          verdict,
          journal: [
            { t: now, nom: 'Contrôle non abouti', agent: agentId, ok: false, det: `Échec du contrôle serveur : ${errorMessage(err)}`, deg: false, sec: false },
            ...s.journal,
          ],
        }));
      }
    }
  },

  // Validation SANS QR ni code (liste « Attendus ») — n'accorde PAS l'accès :
  // ouvre une demande que la sûreté doit confirmer depuis le portail Web (voir
  // DayListSheet.tsx). Remplace l'ancien appel à scanPayload(visit.visitId),
  // toujours refusé INVALID_SIGNATURE (un visitId brut n'est pas un QR signé).
  requestConfirmation: async (visit) => {
    const { post } = useAuthStore.getState();
    const state = get();
    if (state.pendingConfirmations.has(visit.visitId)) return { ok: true };

    // Aucun repli hors ligne possible ici (même raison que scanManualCode,
    // §9) : contrairement à un QR, il n'y a rien à vérifier localement — la
    // demande EXIGE une décision humaine en ligne côté sûreté. La mettre en
    // file pour un renvoi différé donnerait à l'agent l'illusion d'avoir
    // prévenu la sûreté alors que rien n'a été transmis.
    if (state.degraded) {
      return { ok: false, error: 'Connexion au serveur requise pour envoyer une demande de confirmation.' };
    }

    try {
      const result = await api.createConfirmationRequest(
        visit.visitId,
        state.direction,
        post?.checkpointId ?? '',
      );
      set((s) => {
        const next = new Map(s.pendingConfirmations);
        next.set(visit.visitId, result.expiresAt);
        return { pendingConfirmations: next };
      });
      set((s) => ({
        journal: [
          {
            t: Date.now(),
            nom: visit.nom,
            agent: useAuthStore.getState().agent?.matricule ?? '—',
            ok: false,
            det: result.alreadyPending
              ? 'Demande de confirmation déjà en attente auprès de la sûreté'
              : 'Demande de confirmation envoyée à la sûreté (sans QR/code)',
            deg: false,
            sec: false,
          },
          ...s.journal,
        ],
      }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
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
    let visits: OfflineVisit[] = [];
    let expiresAt: number | null = null;
    // Capturé AVANT le rafraîchissement : sert à détecter un NOUVEAU
    // dépassement (§7) pour ne biper qu'au moment où il apparaît, pas à
    // chaque rafraîchissement tant qu'il persiste.
    const previousOverstay = new Map(
      get().visits.map((v) => [v.visitId, v.overstayMinutes ?? 0]),
    );

    try {
      const response = await api.offlineList().catch(() => null);

      if (response?.signedList) {
        const envelope = parseSignedEnvelope(response.signedList);
        const signed = envelope ? parseSignedVisits(verifyWithKnownKeys(envelope)) : null;
        if (signed && signed.length > 0) {
          const display = new Map(response.visits.map((v) => [v.visitId, v]));
          visits = signed.map((entry) => {
            const shown = display.get(entry.visitId);
            return {
              visitId: entry.visitId,
              nom: shown?.nom ?? 'Visiteur',
              mode: shown?.mode ?? 'unique',
              statut: shown?.statut ?? 'valide',
              exclu: entry.isExcluded,
              fenetreDebut: shown?.fenetreDebut ?? entry.scheduledAt,
              fenetreFin: shown?.fenetreFin,
              present: entry.isOnSite,
              overstayMinutes: shown?.overstayMinutes,
              manualCodeHash: entry.manualCodeHash,
            };
          });
          expiresAt = response.expiresAt ?? now + 4 * 3_600_000;
        }
      }

      // Si pas de liste signée exploitable, utiliser les visites en clair de la réponse
      if (visits.length === 0 && response?.visits && response.visits.length > 0) {
        visits = response.visits.map((v) => ({
          visitId: v.visitId,
          nom: v.nom,
          mode: v.mode,
          statut: v.statut,
          exclu: false,
          fenetreDebut: v.fenetreDebut,
          fenetreFin: v.fenetreFin,
          present: v.present,
          overstayMinutes: v.overstayMinutes,
        }));
        expiresAt = response.expiresAt ?? now + 4 * 3_600_000;
      }

      // Repli sur l'API en ligne /api/agent/expected-today si nécessaire
      if (visits.length === 0) {
        const expected = await api.expectedToday().catch(() => []);
        if (expected.length > 0) {
          visits = expected.map((v, i) => ({
            visitId: v.visitId ?? `exp-${i}-${v.nom.toLowerCase().replace(/\s+/g, '-')}`,
            nom: v.nom,
            mode: v.mode ?? 'unique',
            statut: v.statut,
            exclu: false,
            fenetreDebut: v.fenetreDebut,
            fenetreFin: v.fenetreFin,
            present: v.present,
          }));
        }
      }

      // Purge des demandes de confirmation résolues : expirées (miroir du
      // délai serveur) OU dont la visite est désormais présente/sortie (issue
      // réelle constatée). Un refus explicite avant expiration ne change pas
      // le statut de la visite — la purge attend alors le délai, comme le
      // ferait la sûreté en ne répondant pas (même sémantique).
      const stillVisiting = new Map(visits.map((v) => [v.visitId, v]));
      const prunedConfirmations = new Map(
        [...get().pendingConfirmations].filter(([visitId, expiresAt]) => {
          if (now > expiresAt) return false;
          const visit = stillVisiting.get(visitId);
          if (visit && (visit.present || visit.exited)) return false;
          return true;
        }),
      );

      if (visits.length > 0) {
        // Dépassement NOUVEAU (0 → >0 depuis le dernier rafraîchissement) :
        // alerte l'agent au poste, pas seulement visible s'il ouvre la liste.
        // "Dès le niveau 1" : tout passage à un dépassement effectif.
        const newlyOverstaying = visits.filter(
          (v) => (v.overstayMinutes ?? 0) > 0 && (previousOverstay.get(v.visitId) ?? 0) === 0,
        );
        if (newlyOverstaying.length > 0) {
          void get().notifyOverstay(newlyOverstaying);
        }

        set({
          visits,
          offlineListExpiresAt: expiresAt,
          ttlExpired: expiresAt ? now > expiresAt : false,
          lastSync: null,
          pendingConfirmations: prunedConfirmations,
        });
        await setItem(OFFLINE_LIST_KEY, JSON.stringify({ visits, expiresAt }));
      } else {
        // Réponse serveur vide = plus personne d'attendu AUJOURD'HUI (ex. après
        // minuit, avant la première invitation du jour) — ce n'est PAS une
        // panne (celle-ci est déjà gérée par le catch réseau ci-dessous), donc
        // ça DOIT remplacer la liste locale, jamais la laisser telle quelle :
        // sans ce vidage, les visiteurs d'HIER restaient affichés (et
        // tapables pour une demande de confirmation) indéfiniment tant
        // qu'aucun nouveau visiteur n'était invité aujourd'hui.
        const listExpiresAt = response?.expiresAt ?? null;
        set({
          visits: [],
          offlineListExpiresAt: listExpiresAt,
          ttlExpired: false,
          lastSync: 'Aucun visiteur attendu aujourd’hui',
          pendingConfirmations: prunedConfirmations,
        });
        await setItem(OFFLINE_LIST_KEY, JSON.stringify({ visits: [], expiresAt: listExpiresAt }));
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        set({ degraded: true });
      } else {
        set({ lastSync: errorMessage(err) });
      }
    }
  },

  // Alerte locale de dépassement (§7), détectée depuis la liste hors-ligne
  // périodiquement rafraîchie (voir refreshDayList) — pas de connexion temps
  // réel sur mobile. Faute de "niveau" d'escalade dans ce contrat (contrairement
  // au flux SignalR du dashboard Sûreté), un seul bip pour tout dépassement
  // nouvellement détecté ("dès le niveau 1"), même si plusieurs visiteurs
  // basculent lors du même rafraîchissement — pas de barrage de sons.
  notifyOverstay: async (overstaying) => {
    if (get().haptics) {
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch { /* best-effort */ }
    }
    playOverstayBeep(1);
    set((s) => ({
      journal: [
        ...overstaying.map((v) => ({
          t: Date.now(),
          nom: v.nom,
          agent: 'SYSTÈME',
          ok: false,
          det: `Dépassement détecté · +${fmtDur(v.overstayMinutes ?? 0)}`,
          deg: false,
          sec: false,
        })),
        ...s.journal,
      ],
    }));
  },

  resync: async () => {
    const pending = get().pending;
    if (pending.length === 0) return;

    const payload: OfflineScanPayload[] = pending.map((p) => ({
      signedQrPayload: p.signedQrPayload,
      direction: toApiDirection(p.direction),
      agentId: p.agentId,
      scannedAtUtc: new Date(p.occurredAt).toISOString(),
      offlineVerdict: p.offlineVerdict,
      manualCode: p.manualCode,
    }));

    const agentId = useAuthStore.getState().agent?.matricule;
    try {
      const result = await api.resync(payload, agentId);
      const conflicts: JournalEntry[] = result.conflicts.map((c) => ({
        t: Date.now(),
        nom: get().visits.find((v) => v.visitId === c.visitId)?.nom ?? 'Visite',
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
      pendingConfirmations: new Map<string, number>(),
    }),
}));

export function ttlLabel(expiresAt: number | null, expired: boolean): string {
  if (expired || !expiresAt) return 'EXPIRÉ';
  if (Date.now() >= expiresAt) return 'EXPIRÉ';
  return durSince(Date.now(), expiresAt);
}
