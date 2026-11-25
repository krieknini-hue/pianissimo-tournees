# Pianissimo · Tournées Harpe

Application web (PWA) de pilotage des tournées d'entretien et réglage de harpes (**Pianissimo** — Anthony & Marie).

## Fonctionnalités

1. **Demandes & Carte interactive** :
   - Vue **Pôles géographiques** (pastilles chiffrées par zone avec anneau couleur Concert / Étude / Celtique) et vue **Clients** (clusters Leaflet).
   - Suivi des anomalies, conflits et fiches clients complètes.
2. **Planning & Trajets OSRM** :
   - Organisation jour par jour, calcul des durées par instrument (Concert 2h30, Étude 2h, Celtique 45 min) et temps de conduite réels via OSRM.
   - Mode **1 ou 2 luthiers**, épinglage d'horaires contraints, optimisation automatique de l'ordre des arrêts, lien Google Maps multi-étapes et impression A4.
3. **Messages & WhatsApp** :
   - Historique des échanges par client, personnalisation des messages et ouverture directe `wa.me` / `mailto:` (validation humaine obligatoire, zéro envoi autonome).
   - Garde-fous temps réel : contrôle du numéro de contact unique (`06 28 23 07 61`), alerte « proposer avant de confirmer » et synchronisation avec l'horaire du planning.
4. **Pilotage & Rentabilité** :
   - Chiffre d'affaires confirmé / en cours / fourchette, déduction des frais de tournée et suivi des devis / marchés publics.

## Architecture

- **Frontend statique (PWA responsive)** : `webapp/public/` (HTML5, CSS3 mobile-first 320px+, Vanilla JS, Leaflet, OSRM).
- **Backend autonome sur VPS (`vps/app.py`)** :
  - **FastAPI + Uvicorn + SQLite WAL** derrière **Traefik HTTPS** (HSTS, `X-Frame-Options: DENY`, rate-limiting).
  - Authentification par code d'équipe hashé (`scrypt`) + cookie signé HMAC (`HttpOnly; Secure; SameSite=Lax`) et protection anti-brute-force par IP.
  - Synchronisation automatique quasi temps réel (45 s – 3 min, 0 token LLM) depuis la base SMS/WhatsApp unifiée et Gmail pro, avec diffusion temps réel vers les navigateurs via **SSE (`/api/events`)**.
  - Envoi direct WhatsApp (`wacli`) et Email (`google_api.py`) sur **validation humaine explicite**.
  - Aucune donnée client ni aucun secret n'est stocké dans ce dépôt.

## Lancement en local

```bash
cd vps
uvicorn app:app --reload --port 8485
```
