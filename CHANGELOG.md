# Historique & Notes de Mise à Jour — Pianissimo · Tournées Harpe

Application PWA autonome de gestion des tournées harpe pour **Pianissimo** (Anthony & Marie).

---

## Architecture actuelle (VPS autonome)

- **URL publique HTTPS** : `https://tournees.srv1722811.hstgr.cloud`
- **Service système (`systemd`)** : `tournees-harpe.service` (`127.0.0.1:8485`, `MemoryHigh=128M`, `MemoryMax=256M`, `CPUQuota=50%`, `ProtectSystem=strict`)
- **Dossier VPS** : `/srv/tournees-harpe/`
  - Backend : `/srv/tournees-harpe/app.py` (FastAPI + Uvicorn + SQLite WAL)
  - Frontend PWA : `/srv/tournees-harpe/public/`
  - Base de données : `/srv/tournees-harpe/tournees.db` (`chmod 600`)
  - Variables secrètes : `/srv/tournees-harpe/.env` (`chmod 600`) — jamais versionné
- **Reverse Proxy** : Traefik (`/docker/traefik-dynamic/tournees-harpe.yml`), certificat Let's Encrypt, HSTS, `X-Frame-Options: DENY`, rate-limiting `60 req/min` (burst `20`).
- **Synchronisation 0 token LLM** :
  - Lecture seule (`?mode=ro`) de `/opt/data/pianissimo.db` toutes les `45 s` (SMS) et `~2 min 15 s` (WhatsApp).
  - Sync ciblée Gmail pro (`anthony.accordeur@gmail.com`) toutes les `~3 min` via `google_api.py`.
  - Diffusion temps réel vers les navigateurs via Server-Sent Events (`/api/events`).
- **Contrôle humain strict** :
  - Envoi direct WhatsApp (`wacli`) / Email (`google_api.py`) / Devis Abby / Google Agenda uniquement sur clic et confirmation explicite dans l'interface.
  - Aucun numéro autre que `06 28 23 07 61` accepté dans les messages sortants.

---

## Historique des versions

### v5 (25/11/2026) — Ergonomie terrain, Reprises, Barème éditable, Abby & Google Agenda
- **Durées lisibles `XhYY` / `XX min`** partout à la place des heures décimales (`2h30`, `1h`, `45 min`). Suppression des libellés « Fourchette » ambigus.
- **Nouveau type « Reprise réglage (harpe à pédales) »** (`nb_reprise`, `1h` par défaut) pris en compte sur les fiches, les KPI, les anneaux carte (`teal`), le planning et le pilotage CA.
- **Barème configurable dès l'accueil Tournées** : création et modification du tarif (€) et du temps (min) de chaque type de harpe (`Concert`, `Étude`, `Reprise`, `Celtique`).
- **Pilotage · Workflow Devis Abby via Trois** :
  1. Génération d'un **brouillon** de devis (`create-estimate`) avec lignes modifiables.
  2. Prévisualisation du **PDF brouillon**.
  3. **Finalisation** (`finalize-billing`) après contrôle et prévisualisation du **PDF final**.
  4. **Envoi confirmé** au client (Email Abby ou WhatsApp avec PDF via `wacli`), consigné automatiquement dans l'historique.
- **Planning · Export Google Agenda Pianissimo** : bouton `📅 Agenda Pianissimo` avec aperçu (`dry_run`) puis création/mise à jour idempotente dans l'agenda principal (`anthony.accordeur@gmail.com`).

### v4 (25/11/2026) — Migration 100 % VPS & correction Responsive Mobile
- Migration complète de GitHub Pages + Supabase vers `hermes-vps` (FastAPI + SQLite WAL + Traefik HTTPS), conservation des 3 tournées, 22 demandes, 137 messages, 22 brouillons et 13 anomalies.
- Authentification par code d'équipe hashé `scrypt` + cookie `HttpOnly; Secure; SameSite=lax` + blocage anti-brute-force.
- Refonte responsive mobile (`320 px+`, zéro débordement horizontal, zoom tactile autorisé, navigation 5 onglets + stepper `▲ / ▼`, mode maître-détail sur l'onglet Messages).
- Changement du code d'accès équipe (hash `scrypt` dans `/srv/tournees-harpe/.env`).

### v2 – v3 (2026) — Navigation mobile plein écran & barème actualisé
- Temps standards mis à jour : Concert `2h30` (`320 €`), Étude `2h` (`280 €`), Celtique `45 min` (`150 €`).
- Écran d'accueil Tournées séparé + navigation plein écran avec flèches `▲ / ▼` et maître-détail Messages.

### v1 (2026) — Création initiale
- Prototype PWA : Demandes, Carte interactive Pôles/Clients (Leaflet), Planning OSRM (1 ou 2 luthiers), Générateur de messages WhatsApp/Mail et Pilotage financier.

---

## Opérations de maintenance VPS

### Déployer une mise à jour locale vers le VPS
```bash
scp pianissimo-tournees/vps/app.py hermes-vps:/srv/tournees-harpe/app.py
scp -r pianissimo-tournees/webapp/public/* hermes-vps:/srv/tournees-harpe/public/
scp pianissimo-tournees/CHANGELOG.md hermes-vps:/srv/tournees-harpe/CHANGELOG.md
ssh hermes-vps "systemctl restart tournees-harpe.service && systemctl is-active tournees-harpe.service"
```

### Vérifier l'état et les logs du service
```bash
ssh hermes-vps "systemctl status tournees-harpe.service --no-pager -n 20"
ssh hermes-vps "journalctl -u tournees-harpe.service -n 50 --no-pager"
```

### Changer le code d'accès équipe
```bash
ssh hermes-vps 'python3 - << "EOF"
import hashlib, os, secrets
code = "NOUVEAU_CODE_ICI"
salt = secrets.token_hex(16)
digest = hashlib.scrypt(code.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
secret = secrets.token_hex(32)
with open("/srv/tournees-harpe/.env", "w") as f:
    f.write(f"TOURNEES_ACCESS_CODE_HASH={salt}${digest}\nTOURNEES_SESSION_SECRET={secret}\nTOURNEES_BASE_DIR=/srv/tournees-harpe\nPIANISSIMO_DB_PATH=/opt/data/pianissimo.db\n")
os.chmod("/srv/tournees-harpe/.env", 0o600)
EOF
systemctl restart tournees-harpe.service'
```
