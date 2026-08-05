# NOVACCÈS — Cycle de vie d'une visite

Vue de bout en bout : provisionnement, demande de visite, QR signé, contrôle
au poste (nominal **et** mode dégradé), supervision sûreté, sortie, purge.
Complète le schéma simple en y ajoutant la branche coupure réseau et la
détection de conflit à la resynchronisation.

```mermaid
flowchart TD
  %% ─── Provisionnement ───
  subgraph SA["🔑 SuperAdmin — le prestataire"]
    A1["Provisionner le site<br>+ créer le compte Admin Sigasécurité"]
  end

  subgraph AD["🛠 Admin Sigasécurité"]
    B1["Créer les comptes Hôte / Sûreté / Agents<br>+ enrôler les terminaux<br>(URL, clé API terminal, clé publique + kid)"]
  end

  %% ─── Demande et QR ───
  subgraph HO["👤 Hôte"]
    C1["Saisir la demande de visite<br>(visiteur, société, motif, horaire)"]
  end

  subgraph SY1["⚙ Système"]
    D1["Générer le QR signé (ES256, clé privée serveur)<br>+ l'envoyer (WhatsApp, repli email)"]
  end

  %% ─── Poste d'entrée ───
  subgraph AG1["💂 Agent"]
    E1["Prendre le poste<br>(matricule + PIN)"]
    E2["Scanner le QR — poste ENTRÉE"]
  end

  %% ─── Vérification : nominal ou dégradé ───
  R1{"Serveur central<br>joignable ?"}

  subgraph SY2["⚙ Système central — mode nominal"]
    F1["Vérifier signature, fenêtre −20/+15,<br>exclusion, cycle entrée/sortie<br>→ statuer, journaliser, notifier l'hôte"]
  end

  subgraph DEG["📴 Terminal — mode dégradé (REQ-SEC-06)"]
    G1["Vérifier la signature ES256 localement<br>(clé publique embarquée)"]
    G2{"Liste locale signée<br>valide ? (TTL ≤ 4 h)"}
    G3["Statuer sur la liste du jour<br>+ mettre le scan en file de resync"]
    G4["TTL expiré ou hors liste<br>→ REFUS par défaut"]
  end

  V["Verdict plein écran à l'agent<br>+ si ACCÈS : contrôle visuel d'identité<br>(le QR est un jeton au porteur)"]

  %% ─── Resynchronisation ───
  subgraph SYNC["🔄 Reconnexion — resynchronisation"]
    H1["Confronter les scans hors ligne<br>au registre central"]
    H2{"QR révoqué pendant<br>la coupure ?"}
    H3["CONFLIT → événement de sécurité<br>remonté à la Sûreté"]
    H4["Journal consolidé,<br>aucun conflit"]
  end

  %% ─── Supervision ───
  subgraph SU["🛡 Sûreté"]
    I1["Superviser en direct<br>(dépassements, révocation,<br>exclusion si besoin)"]
  end

  %% ─── Sortie et clôture ───
  subgraph AG2["💂 Agent"]
    J1["Scanner le QR — poste SORTIE"]
    J2["Clore le poste (fin de service)"]
  end

  subgraph SY3["⚙ Système + Admin"]
    K1["Purge / anonymisation périodique<br>(politique de rétention)"]
  end

  %% ─── Flux ───
  A1 --> B1 --> C1 --> D1 --> E1 --> E2 --> R1
  R1 -- "oui" --> F1 --> V
  R1 -- "non" --> G1 --> G2
  G2 -- "oui" --> G3 --> V
  G2 -- "non" --> G4 --> V
  G3 -. "au retour réseau" .-> H1
  H1 --> H2
  H2 -- "oui" --> H3 --> I1
  H2 -- "non" --> H4
  F1 --> I1
  I1 -. "révocation pendant coupure<br>= conflit détecté à la resync" .-> H2
  V --> J1 --> J2 --> K1
```

## Points de sécurité portés par le schéma

- **Chaîne de délégation** : chaque niveau ne crée que le niveau du dessous ;
  le prestataire ne gère jamais les comptes du client (moindre privilège
  administratif).
- **Identité de terminal ≠ identité d'agent** : la clé API authentifie
  l'appareil, le matricule + PIN authentifie la personne. Un terminal volé se
  révoque en tuant sa clé API, sans toucher aux comptes agents.
- **`kid` dès l'enrôlement** : les QR portent l'identifiant de la clé qui les
  a signés — la rotation de clé n'invalide pas les QR en circulation.
- **Refus par défaut** : liste locale expirée (TTL ≤ 4 h) ou visiteur hors
  liste → refus, jamais de laisser-passer.
- **La signature prouve le document, pas le porteur** : sur tout accès
  autorisé, l'agent fait un contrôle visuel d'identité (le QR transite par
  WhatsApp/email et reste transférable).
- **Révocation pendant coupure** : non propagée hors ligne (risque accepté et
  borné par le TTL), mais systématiquement détectée à la resynchronisation et
  remontée en événement de sécurité.
