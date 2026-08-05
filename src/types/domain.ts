export type AccessMode = 'unique' | '30j';
export type VisitStatus = 'valide' | 'consomme' | 'revoque';
export type Direction = 'entree' | 'sortie';

/** Codes de verdict alignés sur le backend .NET (`ScanResponseDto.VerdictCode`). */
export type VerdictCode =
  | 'GRANTED'
  | 'CHECKED_OUT'
  | 'INVALID_SIGNATURE'
  | 'DENIED_Excluded'
  | 'DENIED_SuspectedDuplicate'
  | 'DENIED_CycleAlreadyClosed'
  | 'DENIED_AlreadyConsumed'
  | 'DENIED_TooEarly'
  | 'DENIED_TooLate'
  | 'DENIED_NonBusinessDay'
  | 'DENIED_Revoked'
  | 'DENIED_NoActiveEntry'
  // Verdicts propres au mode dégradé : prononcés localement, jamais par le serveur.
  | 'DENIED_OfflineListExpired'
  | 'DENIED_NotInOfflineList'
  // Défaut d'intégration ou serveur injoignable — n'est PAS un refus d'accès.
  | 'SERVER_UNREACHABLE'
  | 'SERVER_ERROR';

export type VerdictKind = 'ok' | 'out' | 'no';

export interface Verdict {
  kind: VerdictKind;
  code: VerdictCode;
  title: string;
  who: string;
  detail: string;
  /** Raison courte affichée en badge mono (refus uniquement). */
  reason?: string;
  degraded: boolean;
  securityEvent: boolean;
}

/** Journal local du poste — trace d'écran, le journal probant vit côté serveur. */
export interface JournalEntry {
  t: number;
  nom: string;
  agent: string;
  ok: boolean;
  out?: boolean;
  det: string;
  deg: boolean;
  sec: boolean;
}

/**
 * Agent identifié par le serveur à la prise de poste. Le code PIN n'est jamais
 * conservé par l'app : il est transmis une fois puis oublié.
 */
export interface Agent {
  matricule: string;
  nom?: string;
  shiftId?: string;
}

export interface PostConfig {
  siteId: string;
  siteLabel: string;
  /** Poste de contrôle choisi à l'ouverture — tracé dans le journal serveur. */
  checkpointId: string;
  checkpointLabel: string;
}

/**
 * Visite telle qu'elle figure dans la liste du jour signée. En mode dégradé,
 * l'app y ajoute l'état observé localement (entrées/sorties survenues pendant
 * la coupure) pour tenir le cycle entrée/sortie jusqu'à la resynchronisation.
 */
export interface OfflineVisit {
  visitId: string;
  nom: string;
  mode: AccessMode;
  statut: VisitStatus;
  /** Bornes de validité calculées par le serveur (jamais par le client). */
  fenetreDebut?: number;
  fenetreFin?: number;
  present: boolean;
  entreeAt?: number;
  /** Cycle entrée/sortie clos (mode unique). */
  exited?: boolean;
}

/** Scan validé pendant une coupure, en attente de confrontation au registre. */
export interface PendingScan {
  visitId: string;
  signedQrPayload: string;
  direction: Direction;
  wasGranted: boolean;
  occurredAt: number;
  verdictCode: VerdictCode;
  wasSecurityEvent: boolean;
}
