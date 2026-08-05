# NOVACCÈS — Application agent (Expo React Native)

Application du poste de contrôle : scan caméra des QR visiteurs, verdict plein
écran, poste directionnel entrée/sortie, liste des attendus du jour, mode
dégradé. Fidèle à la maquette `maquette_novacces.html` (vue « App agent »).

L'application est branchée sur l'API de production `NovAcces.Api`. Elle ne
contient **aucune donnée de démonstration** : sans terminal enrôlé et sans
serveur joignable, aucun contrôle n'est possible — c'est le comportement
attendu d'un dispositif qui commande un accès physique.

**L'arbre de décision du scan vit côté serveur** (`Visit.Scan`) : en
fonctionnement nominal l'app envoie le QR à `POST /api/scan` et affiche le
`verdictCode` reçu, sans jamais le recalculer. La logique locale de
`src/features/scan/engine.ts` ne sert qu'au mode dégradé.

## Démarrage

```bash
npm install
npx expo start
```

Le serveur par défaut est `https://api.sigasacces.com`. Il se surcharge par
`EXPO_PUBLIC_API_URL` (fichier `.env` ou variable au lancement) ou, par site,
par le ticket d'enrôlement lui-même.

## Parcours

0. **Enrôlement du terminal** (une seule fois par appareil) : l'Admin
   Sigasécurité provisionne le terminal puis génère un ticket QR temporaire à
   usage unique. L'app génère sur place sa paire de clés ES256, en prouve la
   possession et reçoit son jeton d'appareil
   (`POST /api/device-enrollments/activate`). La clé privée reste dans le
   Keystore/Keychain ; le site est fixé par l'enrôlement et n'est ensuite
   **jamais choisi par l'agent**. Lien « Réenrôler ce terminal » sur l'écran de
   connexion.
1. **Prise de poste** : matricule + code PIN vérifiés par le serveur
   (`POST /api/agent/shift/start`). Le PIN n'est ni comparé localement ni
   conservé.
2. **Ouverture du poste** : site affiché (ou choisi si le terminal en sert
   plusieurs, `GET /api/agent/sites`) et poste de contrôle issu de
   `GET /api/site/config`. Aucun poste n'est codé en dur.
3. **Scanner** : caméra plein écran. Actions immédiates sous le logo :
   - *⇢ ENTRÉE / ⇠ SORTIE* — sens du poste (grand bouton)
   - *Attendus* — liste du jour (données minimales, moindre privilège)
   - *⋯* — actions secondaires (retour haptique, quitter le poste)

## Mode dégradé (REQ-SEC-06)

`GET /api/health` est interrogé toutes les 30 s : « réseau présent » ne
signifie pas « serveur joignable ». Sur `NetworkError`, le terminal bascule et
décide localement à partir de la liste du jour signée
(`GET /api/agent/offline-list`, rafraîchie toutes les 15 min, TTL ≤ 4 h) :

- la signature ES256 des QR est vérifiée **hors ligne** (`src/lib/crypto.ts`,
  clés publiques de `GET /api/keys/public`) — un QR forgé est donc rejeté même
  pendant une coupure ;
- passé le TTL, plus aucune validation n'est prononcée ;
- les validations hors ligne sont mises en file, persistées, puis confrontées
  au registre central au retour du réseau (`POST /api/agent/resync`) ; les
  écarts remontent en événement de sécurité.

Liste signée et file de resynchronisation survivent au redémarrage du
terminal (stockage sécurisé).

## Cycle de vie d'une visite

Le cycle complet (provisionnement → QR signé → contrôle nominal **et** mode
dégradé → resynchronisation → purge) est schématisé dans
**`docs/cycle-de-vie-visite.md`** (Mermaid).

## Contrat API

`docs/besoins-api-app-agent.md` recense ce que le contrat OpenAPI publié ne
fournit pas encore : schéma de la preuve de possession à l'enrôlement, schémas
de réponse des endpoints agent, structure du QR signé. Les hypothèses prises
en attendant sont marquées `CONTRAT À CONFIRMER` dans le code
(`src/lib/api.ts`, `src/features/auth/enrollment.store.ts`).

## Structure modulaire

```
src/
├── app/                    # Routes Expo Router (fines, délèguent aux features)
│   ├── _layout.tsx         # Hydratation enrôlement + liste signée + file
│   ├── index.tsx           # Redirection selon enrôlement + session
│   ├── enrolement.tsx
│   ├── login.tsx
│   ├── config-poste.tsx
│   └── scanner.tsx
├── components/ui/          # Composants réutilisables (Button, TextField,
│                           # Pill, StatusDot, Logo, IconButton)
├── features/
│   ├── auth/
│   │   ├── auth.store.ts       # Prise de poste, sites, postes de contrôle
│   │   ├── enrollment.store.ts # Identité de l'appareil (persistée, sécurisée)
│   │   └── components/         # EnrolementScreen, LoginScreen, ConfigPosteScreen
│   └── scan/
│       ├── engine.ts       # Décision hors ligne uniquement (pur, testable)
│       ├── scan.store.ts   # Scan, mode dégradé, file de resynchronisation
│       └── components/     # Viewfinder, VerdictOverlay, DayListSheet,
│                           # AppHeader, DegradedBanner, FooterBar,
│                           # TopStatusRow
├── lib/                    # api.ts (client API), crypto.ts (ES256 : identité
│                           # appareil + vérification JWS hors ligne),
│                           # storage.ts (SecureStore / localStorage), time.ts
├── theme/                  # Tokens (couleurs de la maquette)
└── types/                  # Types domaine + codes verdict alignés backend
```

## Vérifications

```bash
npm run typecheck
npm run lint
```
