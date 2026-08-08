# SIGASACCÈS — Application agent (Expo React Native)

Application du poste de contrôle : scan caméra des QR visiteurs, verdict plein
écran, poste directionnel entrée/sortie, liste des attendus du jour, mode
dégradé.

L'application est branchée sur l'API de production `NovAcces.Api` et ne contient
aucune donnée de démonstration : sans terminal enrôlé et sans serveur joignable,
aucun contrôle n'est possible.

L'arbre de décision du scan vit côté serveur (`Visit.Scan`) : en fonctionnement
nominal l'app envoie le QR à `POST /api/scan` et affiche le `verdictCode` reçu,
sans jamais le recalculer. La logique de `src/features/scan/engine.ts` ne sert
qu'au mode dégradé.

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
   Keystore/Keychain ; les sites autorisés sont fixés par l'enrôlement. Lien
   « Réenrôler ce terminal » sur l'écran de connexion.
1. **Prise de poste** : matricule + code PIN vérifiés par le serveur
   (`POST /api/agent/shift/start`). Le PIN n'est ni comparé localement ni
   conservé. Quitter le poste appelle `POST /api/agent/shift/end` (idempotent) :
   sans lui, le poste resté ouvert continuerait d'attribuer les scans au
   matricule parti jusqu'à l'expiration naturelle du jeton.
2. **Ouverture du poste** : site affiché (ou choisi si le terminal en sert
   plusieurs, `GET /api/agent/sites` renvoyant un tableau nu d'identifiants) et
   poste de contrôle issu de `GET /api/site/config`. Aucun poste n'est codé en
   dur.
3. **Scanner** : caméra plein écran. Actions immédiates sous le logo :
   - *⇢ ENTRÉE / ⇠ SORTIE* — sens du poste (grand bouton)
   - *Attendus* — liste du jour (données minimales, moindre privilège)
   - *⋯* — actions secondaires (retour haptique, quitter le poste)

## Mode dégradé (REQ-SEC-06)

`GET /api/health` est interrogé toutes les 30 s : « réseau présent » ne signifie
pas « serveur joignable ». Sur `NetworkError`, le terminal bascule et décide
localement à partir de la liste du jour signée (`GET /api/offline-list`,
rafraîchie toutes les 15 min, TTL ≤ 4 h) :

- la signature ES256 des QR est vérifiée hors ligne (`src/lib/crypto.ts`, clés
  publiques de `GET /api/keys/public`) — un QR forgé est donc rejeté même
  pendant une coupure, tout comme un QR au-delà de son claim `Exp` ;
- seules les entrées de `signedList` fondent un verdict. Le tableau `visits[]`
  servi en clair à côté n'apporte que le nom et la fenêtre d'affichage, jamais
  un droit d'accès ;
- passé le TTL, plus aucune validation n'est prononcée ;
- les validations hors ligne sont mises en file, persistées, puis confrontées au
  registre central au retour du réseau (`POST /api/scan/sync`, dont le 409 porte
  les écarts dans le même corps qu'un 200) ; les écarts remontent en événement
  de sécurité.

Liste signée et file de resynchronisation survivent au redémarrage du terminal
(stockage sécurisé).

## Contrat API

Le contrat est spécifié depuis la réponse backend du 05/08/2026 et les réponses
sont désormais typées dans `GET /swagger/v1/swagger.json`. Trois points
structurent le client :

**Authentification.** La policy `AgentTerminal` exige l'en-tête `X-Api-Key` sur
**chaque** requête. Le `Authorization: Bearer <jeton de poste>` obtenu à la prise
de poste s'ajoute à la clé de terminal, il ne la remplace jamais. `X-Site-Id` est
obligatoire pour un terminal multi-sites et ignoré sans effet pour un mono-site.

**Preuve de possession à l'enrôlement.** Le serveur vérifie la signature ES256 de
`"{ticket}|{deviceInstanceId}"` (UTF-8), en encodage IEEE P1363 (r‖s, 64 octets —
pas DER) puis Base64URL. Isolé dans `buildProofMessage` / `encodeProof`
(`src/features/auth/enrollment.store.ts`).

**Enveloppes signées.** Le QR visiteur et `signedList` ne sont pas des JWS
RFC 7515 : c'est une enveloppe JSON custom
`{ PayloadB64Url, SignatureB64Url, KeyId }`, la signature portant sur les octets
du payload JSON décodé. `signedList` arrive en outre sérialisé en chaîne, d'où un
second `JSON.parse`. Voir `parseSignedEnvelope` / `verifySignedEnvelope`
(`src/lib/crypto.ts`).

⚠️ La vérification passe `lowS: false` à `@noble/curves`, et doit le garder :
la bibliothèque n'accepte par défaut que les signatures à S bas, alors que
`ECDsa.SignData` côté .NET ne normalise pas et produit un S haut une fois sur
deux. Sans cette option, la moitié des QR authentiques serait refusée hors ligne
en « QR INVALIDE » — un défaut invisible en test unitaire tant qu'on ne rejoue
pas plusieurs signatures.

**Resynchronisation.** `/api/scan/sync` (et non `/api/agent/resync`, réservée à
l'app MAUI). Le corps est un **tableau nu** de
`{ signedQrPayload, direction, agentId, scannedAtUtc, offlineVerdict }` : le
serveur redérive la visite depuis le QR signé, il n'attend donc ni `visitToken`
ni indicateur d'autorisation. Un 409 n'est pas une erreur, il porte les écarts
dans le même corps qu'un 200.

## Organisation du code

`src/app/` ne contient que les routes Expo Router, qui délèguent aux écrans de
`src/features/`. Chaque feature (`auth`, `scan`) regroupe son store Zustand et
ses composants. `src/lib/` porte le client API, la crypto ES256 et le stockage
sécurisé ; `src/components/ui/` les composants partagés ; `src/theme/` les
couleurs de la maquette.

## Disponible côté serveur, pas encore côté app

- **Code de secours** (`POST /api/scan/manual-code`) : format `XXXX-XXXX`, remis
  une seule fois à la création de la visite, même réponse que `POST /api/scan`.
  Sa résolution nécessite une recherche en base, donc **inutilisable hors
  ligne** — l'écran devra afficher cette limite plutôt qu'échouer en silence.
  Aucune saisie manuelle n'existe aujourd'hui dans l'app.
- **Hub SignalR** `/hubs/scan-events` (messages `VisitRevoked`, `VisitCreated`),
  authentifié par `?access_token=`. Permettrait d'invalider un QR sans attendre
  le rafraîchissement de 15 min de la liste du jour.

## Vérifications

```bash
npm run typecheck
npm run lint
```
