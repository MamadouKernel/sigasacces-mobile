import {
  decideExpiredQr,
  decideInvalidSignature,
  decideListExpired,
  decideManualCodeListExpired,
  decideManualCodeNotFound,
  decideNotInList,
  decideOffline,
  windowState,
  type ScanContext,
} from '../engine';
import type { OfflineVisit } from '@/types/domain';

// Moteur de décision hors ligne (mode dégradé) : miroir client de la logique
// serveur (Domain/Visit.cs — Visit.Scan). Aucun test automatisé n'existait
// jusqu'ici côté mobile (revue d'écart contractuel du 10/08/2026), alors que
// l'équivalent .NET (OfflineScanEvaluatorTests, OfflineQrVerifierTests) est
// couvert depuis longtemps — ces tests reproduisent les mêmes scénarios.

const NOW = 1_800_000_000_000; // instant fixe arbitraire (ms epoch), lisibilité des assertions

function ctx(overrides: Partial<ScanContext> = {}): ScanContext {
  return { direction: 'entree', ttlExpired: false, agentId: 'poste-1', now: NOW, ...overrides };
}

function visit(overrides: Partial<OfflineVisit> = {}): OfflineVisit {
  return {
    visitId: 'v1',
    nom: 'Amara Traoré',
    mode: 'unique',
    statut: 'valide',
    exclu: false,
    present: false,
    ...overrides,
  };
}

describe('windowState', () => {
  it('retourne "ok" quand aucune borne n\'est définie', () => {
    expect(windowState(visit(), NOW)).toBe('ok');
  });

  it('retourne "early" avant la fenêtre de début', () => {
    expect(windowState(visit({ fenetreDebut: NOW + 1000 }), NOW)).toBe('early');
  });

  it('retourne "late" après la fenêtre de fin', () => {
    expect(windowState(visit({ fenetreFin: NOW - 1000 }), NOW)).toBe('late');
  });

  it('retourne "ok" strictement dans la fenêtre (bornes incluses)', () => {
    expect(windowState(visit({ fenetreDebut: NOW, fenetreFin: NOW }), NOW)).toBe('ok');
  });
});

describe('verdicts statiques (liste expirée, signature, QR expiré, code de secours)', () => {
  it('decideListExpired : DENIED_OfflineListExpired, pas un événement de sécurité', () => {
    const d = decideListExpired(ctx());
    expect(d.verdict.code).toBe('DENIED_OfflineListExpired');
    expect(d.verdict.securityEvent).toBe(false);
    expect(d.verdict.degraded).toBe(true);
  });

  it('decideInvalidSignature : INVALID_SIGNATURE, événement de sécurité (QR potentiellement forgé)', () => {
    const d = decideInvalidSignature(ctx());
    expect(d.verdict.code).toBe('INVALID_SIGNATURE');
    expect(d.verdict.securityEvent).toBe(true);
    expect(d.journal.sec).toBe(true);
  });

  it('decideExpiredQr : INVALID_SIGNATURE (même code que le serveur), pas un événement de sécurité', () => {
    const d = decideExpiredQr(ctx());
    expect(d.verdict.code).toBe('INVALID_SIGNATURE');
    expect(d.verdict.securityEvent).toBe(false);
  });

  it('decideManualCodeListExpired : DENIED_OfflineListExpired', () => {
    expect(decideManualCodeListExpired(ctx()).verdict.code).toBe('DENIED_OfflineListExpired');
  });

  it('decideManualCodeNotFound : INVALID_CODE, pas un événement de sécurité', () => {
    const d = decideManualCodeNotFound(ctx());
    expect(d.verdict.code).toBe('INVALID_CODE');
    expect(d.verdict.securityEvent).toBe(false);
  });

  it('decideNotInList : DENIED_NotInOfflineList', () => {
    expect(decideNotInList(ctx()).verdict.code).toBe('DENIED_NotInOfflineList');
  });
});

describe('decideOffline — poste SORTIE (jamais bloquée)', () => {
  it('visiteur présent -> CHECKED_OUT, patch.present=false', () => {
    const v = visit({ present: true, entreeAt: NOW - 30 * 60_000 });
    const d = decideOffline(v, ctx({ direction: 'sortie' }));
    expect(d.verdict.code).toBe('CHECKED_OUT');
    expect(d.verdict.kind).toBe('out');
    expect(d.patch.present).toBe(false);
    expect(d.journal.ok).toBe(true);
    expect(d.journal.out).toBe(true);
  });

  it('mode unique -> le cycle est marqué clos (exited=true)', () => {
    const v = visit({ mode: 'unique', present: true, entreeAt: NOW - 1000 });
    const d = decideOffline(v, ctx({ direction: 'sortie' }));
    expect(d.patch.exited).toBe(true);
  });

  it('mode 30j -> exited n\'est pas forcé à true', () => {
    const v = visit({ mode: '30j', present: true, entreeAt: NOW - 1000, exited: false });
    const d = decideOffline(v, ctx({ direction: 'sortie' }));
    expect(d.patch.exited).toBe(false);
  });

  it('QR révoqué pendant la présence -> sortie quand même autorisée', () => {
    const v = visit({ present: true, entreeAt: NOW - 1000, statut: 'revoque' });
    const d = decideOffline(v, ctx({ direction: 'sortie' }));
    expect(d.verdict.code).toBe('CHECKED_OUT');
    expect(d.verdict.detail).toContain('révoqué');
  });

  it('aucune entrée active -> DENIED_NoActiveEntry (refus, mais pas un événement de sécurité)', () => {
    const v = visit({ present: false });
    const d = decideOffline(v, ctx({ direction: 'sortie' }));
    expect(d.verdict.code).toBe('DENIED_NoActiveEntry');
    expect(d.verdict.securityEvent).toBe(false);
  });
});

describe('decideOffline — poste ENTRÉE', () => {
  it('exclusion : refuse même si tout le reste serait valide (priorité absolue)', () => {
    const v = visit({ exclu: true, statut: 'valide', present: false });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_Excluded');
    expect(d.verdict.securityEvent).toBe(true);
  });

  it('déjà présent -> DENIED_SuspectedDuplicate (suspicion de copie), événement de sécurité', () => {
    const v = visit({ present: true, entreeAt: NOW - 1000 });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_SuspectedDuplicate');
    expect(d.verdict.securityEvent).toBe(true);
  });

  it('statut révoqué -> DENIED_Revoked', () => {
    const v = visit({ statut: 'revoque', present: false });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_Revoked');
  });

  it('mode unique déjà consommé ET déjà sorti -> DENIED_CycleAlreadyClosed', () => {
    const v = visit({ mode: 'unique', statut: 'consomme', exited: true, present: false });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_CycleAlreadyClosed');
  });

  it('mode unique déjà consommé mais pas encore sorti -> DENIED_AlreadyConsumed (anti-rejeu)', () => {
    const v = visit({ mode: 'unique', statut: 'consomme', exited: false, present: false });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_AlreadyConsumed');
  });

  it('trop tôt (avant la fenêtre) -> DENIED_TooEarly, événement de sécurité', () => {
    const v = visit({ fenetreDebut: NOW + 15 * 60_000 });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_TooEarly');
    expect(d.verdict.securityEvent).toBe(true);
  });

  it('trop tard (après la fenêtre) -> DENIED_TooLate', () => {
    const v = visit({ fenetreFin: NOW - 20 * 60_000 });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('DENIED_TooLate');
  });

  it('accès nominal mode unique -> GRANTED, patch marque présent + consommé', () => {
    const v = visit({ mode: 'unique', statut: 'valide', present: false });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('GRANTED');
    expect(d.verdict.kind).toBe('ok');
    expect(d.patch.present).toBe(true);
    expect(d.patch.entreeAt).toBe(NOW);
    expect(d.patch.exited).toBe(false);
    expect(d.patch.statut).toBe('consomme');
    expect(d.journal.ok).toBe(true);
  });

  it('accès nominal mode 30j -> GRANTED, mais le statut n\'est PAS marqué consommé (accès répété autorisé)', () => {
    const v = visit({ mode: '30j', statut: 'valide', present: false });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('GRANTED');
    expect(d.patch.present).toBe(true);
    expect(d.patch.statut).toBeUndefined();
  });

  it('fenêtre bornée mais dans les clous -> accordé, pas de refus TooEarly/TooLate', () => {
    const v = visit({ fenetreDebut: NOW - 5 * 60_000, fenetreFin: NOW + 5 * 60_000 });
    const d = decideOffline(v, ctx({ direction: 'entree' }));
    expect(d.verdict.code).toBe('GRANTED');
  });
});
