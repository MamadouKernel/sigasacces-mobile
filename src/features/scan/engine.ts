import { durSince, fmt } from '@/lib/time';
import type { Direction, JournalEntry, OfflineVisit, Verdict, VerdictCode } from '@/types/domain';

// Décision du mode dégradé uniquement : en nominal le verdict vient de
// POST /api/scan. Toute validation prononcée ici part en file de resync.

export interface ScanContext {
  direction: Direction;
  ttlExpired: boolean;
  agentId: string;
  now: number;
}

export interface ScanDecision {
  verdict: Verdict;
  patch: Partial<OfflineVisit>;
  journal: JournalEntry;
}

export type WindowState = 'early' | 'ok' | 'late';

export function windowState(visit: OfflineVisit, now: number): WindowState {
  if (visit.fenetreDebut !== undefined && now < visit.fenetreDebut) return 'early';
  if (visit.fenetreFin !== undefined && now > visit.fenetreFin) return 'late';
  return 'ok';
}

function entry(
  ctx: ScanContext,
  nom: string,
  fields: Partial<JournalEntry> & { det: string },
): JournalEntry {
  return { t: ctx.now, nom, agent: ctx.agentId, ok: false, deg: true, sec: false, ...fields };
}

function deny(
  ctx: ScanContext,
  nom: string,
  who: string,
  code: VerdictCode,
  reason: string,
  det: string,
): ScanDecision {
  return {
    verdict: {
      kind: 'no',
      code,
      title: 'ACCÈS REFUSÉ',
      who,
      detail: 'Diriger le visiteur vers le poste de garde',
      reason,
      degraded: true,
      securityEvent: true,
    },
    patch: {},
    journal: entry(ctx, nom, { sec: true, det }),
  };
}

export function decideListExpired(ctx: ScanContext): ScanDecision {
  return {
    verdict: {
      kind: 'no',
      code: 'DENIED_OfflineListExpired',
      title: 'VALIDATION IMPOSSIBLE',
      who: 'Liste locale expirée',
      detail: 'Reconnexion requise · diriger le visiteur vers le poste de garde',
      reason: 'LISTE LOCALE EXPIRÉE (TTL)',
      degraded: true,
      securityEvent: false,
    },
    patch: {},
    journal: entry(ctx, 'QR non vérifié', {
      det: 'Validation hors ligne refusée : liste locale au-delà de son TTL',
    }),
  };
}

export function decideInvalidSignature(ctx: ScanContext): ScanDecision {
  return {
    verdict: {
      kind: 'no',
      code: 'INVALID_SIGNATURE',
      title: 'QR INVALIDE',
      who: 'Signature non vérifiable',
      detail: 'Diriger le porteur vers le poste de garde',
      reason: 'SIGNATURE INVALIDE — QR ALTÉRÉ',
      degraded: true,
      securityEvent: true,
    },
    patch: {},
    journal: entry(ctx, 'QR inconnu', {
      sec: true,
      det: 'Signature cryptographique invalide — contenu du QR altéré ou forgé (détecté hors ligne : la vérification ne requiert pas le serveur)',
    }),
  };
}

// Le claim Exp du QR se lit sans réseau : le serveur classe ce cas en
// INVALID_SIGNATURE, on prononce le même code hors ligne.
export function decideExpiredQr(ctx: ScanContext): ScanDecision {
  return {
    verdict: {
      kind: 'no',
      code: 'INVALID_SIGNATURE',
      title: 'QR EXPIRÉ',
      who: 'QR hors de sa durée de validité',
      detail: 'Le visiteur doit faire régénérer son QR · poste de garde',
      reason: 'QR EXPIRÉ',
      degraded: true,
      securityEvent: false,
    },
    patch: {},
    journal: entry(ctx, 'QR expiré', {
      det: "QR au-delà de sa date d'expiration cryptographique (claim Exp) — refus prononcé hors ligne",
    }),
  };
}

export function decideNotInList(ctx: ScanContext): ScanDecision {
  return {
    verdict: {
      kind: 'no',
      code: 'DENIED_NotInOfflineList',
      title: 'VÉRIFICATION IMPOSSIBLE',
      who: 'Visiteur hors liste locale',
      detail: 'Hors ligne : ce QR ne peut pas être contrôlé · poste de garde',
      reason: 'HORS LISTE LOCALE',
      degraded: true,
      securityEvent: false,
    },
    patch: {},
    journal: entry(ctx, 'QR hors liste', {
      det: 'QR absent de la liste locale signée (émis après la coupure ou hors journée) — vérification serveur impossible',
    }),
  };
}

export function decideOffline(visit: OfflineVisit, ctx: ScanContext): ScanDecision {
  const who = visit.nom;

  // Poste SORTIE : les sorties ne sont jamais bloquées.
  if (ctx.direction === 'sortie') {
    if (visit.present) {
      const presence = visit.entreeAt ? durSince(visit.entreeAt, ctx.now) : '—';
      let det = `Sortie enregistrée par scan · présence : ${presence}`;
      let detail = `Présence : ${presence} · bonne route`;
      if (visit.statut === 'revoque') {
        det += ' · QR révoqué pendant la présence — sortie autorisée, ré-entrée impossible';
        detail = 'QR révoqué : sortie autorisée, toute ré-entrée sera refusée';
      }
      if (visit.mode === 'unique') det += ' · cycle clos';
      return {
        verdict: {
          kind: 'out',
          code: 'CHECKED_OUT',
          title: 'SORTIE ENREGISTRÉE',
          who,
          detail,
          degraded: true,
          securityEvent: false,
        },
        patch: { present: false, exited: visit.mode === 'unique' ? true : visit.exited },
        journal: entry(ctx, visit.nom, { ok: true, out: true, det }),
      };
    }
    return {
      verdict: {
        kind: 'no',
        code: 'DENIED_NoActiveEntry',
        title: 'AUCUNE ENTRÉE ENREGISTRÉE',
        who,
        detail: "Ce visiteur n'est pas enregistré sur site · diriger vers le poste d'entrée",
        reason: 'SORTIE IMPOSSIBLE',
        degraded: true,
        securityEvent: false,
      },
      patch: {},
      journal: entry(ctx, visit.nom, {
        det: 'Scan au poste SORTIE sans entrée enregistrée — visiteur dirigé vers l’entrée',
      }),
    };
  }

  // Poste ENTRÉE. L'exclusion, portée par la liste signée, prime sur tout le reste.
  if (visit.exclu) {
    return deny(
      ctx, visit.nom, who, 'DENIED_Excluded', 'VOIR POSTE DE GARDE',
      "Porteur inscrit sur la liste d'exclusion — refus prononcé hors ligne depuis la liste signée",
    );
  }

  // Titulaire déjà sur site = suspicion de QR copié ou volé.
  if (visit.present) {
    const entree = visit.entreeAt ? fmt(visit.entreeAt) : '—';
    return {
      verdict: {
        kind: 'no',
        code: 'DENIED_SuspectedDuplicate',
        title: 'DÉJÀ SUR SITE',
        who,
        detail: `Anomalie : ce visiteur est enregistré sur site depuis ${entree} · vérification d'identité requise`,
        reason: 'SUSPICION DE COPIE — VOIR POSTE DE GARDE',
        degraded: true,
        securityEvent: true,
      },
      patch: {},
      journal: entry(ctx, visit.nom, {
        sec: true,
        det: `Présentation à l'ENTRÉE d'un QR dont le titulaire est déjà enregistré sur site (entré à ${entree}) — QR possiblement copié ou volé : vérification d'identité au poste de garde`,
      }),
    };
  }

  if (visit.statut === 'revoque') {
    return deny(ctx, visit.nom, who, 'DENIED_Revoked', 'QR RÉVOQUÉ PAR LA SÛRETÉ', "Scan d'un QR révoqué");
  }
  if (visit.mode === 'unique' && visit.statut === 'consomme' && visit.exited) {
    return deny(
      ctx, visit.nom, who, 'DENIED_CycleAlreadyClosed', 'CYCLE ENTRÉE/SORTIE CLOS',
      "Réutilisation d'un QR unique après sortie du visiteur — si le porteur conteste, le QR a pu être copié : vérification d'identité",
    );
  }
  if (visit.mode === 'unique' && visit.statut === 'consomme') {
    return deny(
      ctx, visit.nom, who, 'DENIED_AlreadyConsumed', 'QR DÉJÀ CONSOMMÉ — ANTI-REJEU',
      "Tentative de réutilisation d'un QR à passage unique",
    );
  }

  const w = windowState(visit, ctx.now);
  if (w === 'late' && visit.fenetreFin !== undefined) {
    return deny(
      ctx, visit.nom, who, 'DENIED_TooLate', 'HORS FENÊTRE DE VALIDITÉ',
      `Tentative hors fenêtre : validité close à ${fmt(visit.fenetreFin)}`,
    );
  }
  if (w === 'early' && visit.fenetreDebut !== undefined) {
    return deny(
      ctx, visit.nom, who, 'DENIED_TooEarly', `TROP TÔT — FENÊTRE À ${fmt(visit.fenetreDebut)}`,
      `Présentation avant l'ouverture de la fenêtre (${fmt(visit.fenetreDebut)}) — événement de sécurité REQ-SEC-05`,
    );
  }

  let det = visit.mode === 'unique' ? 'Accès unique · fenêtre respectée' : 'Accès 30 j';
  const patch: Partial<OfflineVisit> = { present: true, entreeAt: ctx.now, exited: false };
  if (visit.mode === 'unique') {
    patch.statut = 'consomme';
    det += ' · entrée consommée (anti-rejeu local)';
  }
  return {
    verdict: {
      kind: 'ok',
      code: 'GRANTED',
      title: 'ACCÈS AUTORISÉ',
      who,
      detail: `${visit.mode === 'unique' ? 'Accès unique' : 'Accès 30 jours'} · validation hors ligne`,
      degraded: true,
      securityEvent: false,
    },
    patch,
    journal: entry(ctx, visit.nom, { ok: true, det: `${det} · à resynchroniser` }),
  };
}
