export type AccessMode = 'unique' | '30j';
export type VisitStatus = 'valide' | 'consomme' | 'revoque';
export type Direction = 'entree' | 'sortie';

// Énumération exhaustive de ScanResponseDto.VerdictCode (Swagger, POST /api/scan).
export type VerdictCode =
  | 'GRANTED'
  | 'CHECKED_OUT'
  | 'INVALID_SIGNATURE'
  | 'INVALID_CODE'
  | 'DENIED_Excluded'
  | 'DENIED_SuspectedDuplicate'
  | 'DENIED_CycleAlreadyClosed'
  | 'DENIED_AlreadyConsumed'
  | 'DENIED_TooEarly'
  | 'DENIED_TooLate'
  | 'DENIED_NonBusinessDay'
  | 'DENIED_Revoked'
  | 'DENIED_NoActiveEntry'
  // prononcés localement en mode dégradé, jamais par le serveur
  | 'DENIED_OfflineListExpired'
  | 'DENIED_NotInOfflineList'
  // incident technique, pas un refus d'accès
  | 'SERVER_ERROR';

export type VerdictKind = 'ok' | 'out' | 'no';

export interface Verdict {
  kind: VerdictKind;
  code: VerdictCode;
  title: string;
  who: string;
  detail: string;
  reason?: string;
  degraded: boolean;
  securityEvent: boolean;
}

// Trace d'écran uniquement, le journal probant vit côté serveur.
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

export interface Agent {
  matricule: string;
  nom?: string;
}

export interface PostConfig {
  siteId: string;
  siteLabel: string;
  checkpointId: string;
  checkpointLabel: string;
}

// Visite de la liste du jour signée, complétée par l'état observé localement
// pendant une coupure (cycle entrée/sortie tenu jusqu'à la resync).
export interface OfflineVisit {
  visitId: string;
  nom: string;
  mode: AccessMode;
  statut: VisitStatus;
  exclu: boolean;
  fenetreDebut?: number;
  fenetreFin?: number;
  present: boolean;
  entreeAt?: number;
  exited?: boolean;
}

export interface PendingScan {
  signedQrPayload: string;
  direction: Direction;
  agentId: string;
  occurredAt: number;
  offlineVerdict: VerdictCode;
}
