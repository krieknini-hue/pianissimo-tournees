# Pianissimo · Tournées Harpe

Application web (PWA) de pilotage des tournées d'entretien et réglage de harpes (**Pianissimo** — Anthony & Marie).

## Fonctionnalités

1. **Demandes & Carte interactive** :
   - Vue **Pôles géographiques** (pastilles chiffrées par zone avec anneau couleur Concert / Étude / Celtique) et vue **Clients** (clusters Leaflet).
   - Suivi des anomalies, conflits et fiches clients complètes.
2. **Planning & Trajets OSRM** :
   - Organisation jour par jour, calcul des durées par instrument (Concert 3h, Étude 3h, Celtique 1h30) et temps de conduite réels via OSRM.
   - Mode **1 ou 2 luthiers**, épinglage d'horaires contraints, optimisation automatique de l'ordre des arrêts, lien Google Maps multi-étapes et impression A4.
3. **Messages & WhatsApp** :
   - Historique des échanges par client, personnalisation des messages et ouverture directe `wa.me` / `mailto:` (validation humaine obligatoire, zéro envoi autonome).
   - Garde-fous temps réel : contrôle du numéro de contact unique (`06 28 23 07 61`), alerte « proposer avant de confirmer » et synchronisation avec l'horaire du planning.
4. **Pilotage & Rentabilité** :
   - Chiffre d'affaires confirmé / en cours / fourchette, déduction des frais de tournée et suivi des devis / marchés publics.

## Architecture

- **Frontend statique (GitHub Pages)** : `webapp/public/` (HTML5, CSS3, Vanilla JS, Leaflet, `@supabase/supabase-js` v2).
- **Backend & Temps réel (Supabase)** :
  - PostgreSQL avec **Row Level Security strict** (`TO authenticated`) — aucune donnée personnelle n'est stockée dans ce dépôt.
  - Edge Function `supabase/functions/tournees-auth/index.ts` pour l'authentification par code d'équipe partagé.
  - Synchronisation temps réel via Supabase Realtime.

## Lancement en local

```bash
node webapp/server.js
# Ouvrir http://localhost:3010
```
