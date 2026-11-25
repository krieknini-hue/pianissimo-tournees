#!/usr/bin/env python3
"""Backend autonome FastAPI + SQLite WAL pour Pianissimo · Tournées Harpe.

Exécution locale sur le VPS (127.0.0.1:8485) derrière Traefik HTTPS :
- Authentification par code d'équipe hashé (scrypt) + cookie HttpOnly/Secure signé HMAC
- Anti-brute-force par IP (8 tentatives -> blocage 15 min)
- Base dédiée SQLite WAL (/srv/tournees-harpe/tournees.db)
- Lecture seule sur /opt/data/pianissimo.db pour remonter SMS & WhatsApp en quasi temps réel (0 token)
- Synchronisation ciblée Gmail pro (anthony.accordeur@gmail.com) via google_api.py
- Envoi direct WhatsApp (wacli) et Email (google_api.py) uniquement sur validation explicite
- Flux SSE (/api/events) pour mise à jour temps réel des navigateurs
"""

from __future__ import annotations

import asyncio
import email.utils
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(os.environ.get("TOURNEES_BASE_DIR", "/srv/tournees-harpe"))
DB_PATH = Path(os.environ.get("TOURNEES_DB_PATH", str(BASE_DIR / "tournees.db")))
PUBLIC_DIR = Path(os.environ.get("TOURNEES_PUBLIC_DIR", str(BASE_DIR / "public")))
PIANISSIMO_DB = Path(os.environ.get("PIANISSIMO_DB_PATH", "/opt/data/pianissimo.db"))
WACLI_SYNC_SCRIPT = Path(os.environ.get("WACLI_SYNC_SCRIPT", "/opt/data/sync_wacli_to_unified.py"))
GOOGLE_API_SCRIPT = Path(
    os.environ.get(
        "GOOGLE_API_SCRIPT",
        "/root/.hermes/skills-shared/productivity/google-workspace/scripts/google_api.py",
    )
)
ANTHONY_HERMES_HOME = os.environ.get("ANTHONY_HERMES_HOME", "/root/.hermes/profiles/anthony")
WACLI_BIN = os.environ.get("WACLI_BIN", "/usr/local/bin/wacli")

ACCESS_CODE_HASH = os.environ.get("TOURNEES_ACCESS_CODE_HASH", "")
SESSION_SECRET = os.environ.get("TOURNEES_SESSION_SECRET", "")
COOKIE_NAME = "pt_session"
SESSION_TTL_SEC = 30 * 24 * 3600

ANTHONY_DIGITS = "33628230761"
FR_MOBILE_REGEX = re.compile(r"(?:0|\+33|0033)\s*[67](?:[\s.-]*\d{2}){4}")

# Anti-brute-force en mémoire par IP
LOGIN_FAILURES: dict[str, list[float]] = {}
MAX_LOGIN_ATTEMPTS = 8
LOGIN_WINDOW_SEC = 900

# Abonnés SSE temps réel
SSE_CLIENTS: set[asyncio.Queue[str]] = set()
SYNC_LOCK = asyncio.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tournees (
              id TEXT PRIMARY KEY,
              slug TEXT UNIQUE NOT NULL,
              nom TEXT NOT NULL,
              date_debut TEXT NOT NULL,
              date_fin TEXT NOT NULL,
              statut TEXT NOT NULL DEFAULT 'en_preparation',
              nb_luthiers INTEGER NOT NULL DEFAULT 2,
              bareme_json TEXT NOT NULL,
              frais_json TEXT NOT NULL,
              notes TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS demandes (
              id TEXT PRIMARY KEY,
              tournee_id TEXT NOT NULL REFERENCES tournees(id) ON DELETE CASCADE,
              external_key TEXT,
              nom TEXT NOT NULL,
              categorie TEXT NOT NULL DEFAULT 'particulier',
              secteur TEXT NOT NULL DEFAULT 'Autre',
              ville TEXT NOT NULL DEFAULT '',
              cp TEXT NOT NULL DEFAULT '',
              pays TEXT NOT NULL DEFAULT '',
              adresse TEXT NOT NULL DEFAULT '',
              adresse_verifiee INTEGER NOT NULL DEFAULT 0,
              latitude REAL,
              longitude REAL,
              canal_prefere TEXT NOT NULL DEFAULT 'WhatsApp',
              telephone TEXT NOT NULL DEFAULT '',
              email TEXT NOT NULL DEFAULT '',
              nb_concert INTEGER NOT NULL DEFAULT 0,
              nb_etude INTEGER NOT NULL DEFAULT 0,
              nb_celtique INTEGER NOT NULL DEFAULT 0,
              nb_inconnu INTEGER NOT NULL DEFAULT 0,
              instruments_detail TEXT NOT NULL DEFAULT '',
              duree_estimee_h REAL NOT NULL DEFAULT 0,
              montant_estime_eur REAL,
              montant_note TEXT NOT NULL DEFAULT '',
              statut TEXT NOT NULL DEFAULT 'a_qualifier',
              jour_date TEXT,
              heure_debut TEXT,
              ordre_jour INTEGER NOT NULL DEFAULT 0,
              creneau_epingle INTEGER NOT NULL DEFAULT 0,
              contraintes TEXT NOT NULL DEFAULT '',
              citation_source TEXT NOT NULL DEFAULT '',
              action_requise TEXT NOT NULL DEFAULT '',
              devis_statut TEXT NOT NULL DEFAULT 'non_requis',
              devis_ref TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (tournee_id, external_key)
            );

            CREATE TABLE IF NOT EXISTS messages_historique (
              id TEXT PRIMARY KEY,
              demande_id TEXT NOT NULL REFERENCES demandes(id) ON DELETE CASCADE,
              tournee_id TEXT NOT NULL REFERENCES tournees(id) ON DELETE CASCADE,
              canal TEXT NOT NULL,
              direction TEXT NOT NULL,
              horodatage TEXT NOT NULL,
              contenu TEXT NOT NULL,
              auteur TEXT NOT NULL DEFAULT '',
              external_hash TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (demande_id, external_hash)
            );

            CREATE TABLE IF NOT EXISTS brouillons_messages (
              id TEXT PRIMARY KEY,
              demande_id TEXT NOT NULL REFERENCES demandes(id) ON DELETE CASCADE,
              tournee_id TEXT NOT NULL REFERENCES tournees(id) ON DELETE CASCADE,
              canal TEXT NOT NULL DEFAULT 'WhatsApp',
              objet TEXT NOT NULL DEFAULT '',
              texte_propose TEXT NOT NULL DEFAULT '',
              texte_final TEXT NOT NULL DEFAULT '',
              statut TEXT NOT NULL DEFAULT 'brouillon',
              valide_par TEXT NOT NULL DEFAULT '',
              envoye_le TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (demande_id, canal)
            );

            CREATE TABLE IF NOT EXISTS anomalies (
              id TEXT PRIMARY KEY,
              tournee_id TEXT NOT NULL REFERENCES tournees(id) ON DELETE CASCADE,
              demande_id TEXT REFERENCES demandes(id) ON DELETE SET NULL,
              severite TEXT NOT NULL,
              categorie TEXT NOT NULL,
              titre TEXT NOT NULL,
              description TEXT NOT NULL,
              preuve_source TEXT NOT NULL DEFAULT '',
              action_proposee TEXT NOT NULL DEFAULT '',
              resolue INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_dem_tournee ON demandes(tournee_id, jour_date, ordre_jour);
            CREATE INDEX IF NOT EXISTS idx_msg_demande ON messages_historique(demande_id, horodatage);
            CREATE INDEX IF NOT EXISTS idx_msg_tournee ON messages_historique(tournee_id);
            CREATE INDEX IF NOT EXISTS idx_bro_tournee ON brouillons_messages(tournee_id);
            CREATE INDEX IF NOT EXISTS idx_ano_tournee ON anomalies(tournee_id);
            """
        )


def broadcast_event(event_name: str) -> None:
    for q in list(SSE_CLIENTS):
        try:
            q.put_nowait(event_name)
        except asyncio.QueueFull:
            pass


def verify_access_code(candidate: str) -> bool:
    if not ACCESS_CODE_HASH or "$" not in ACCESS_CODE_HASH:
        return False
    try:
        salt_hex, expected_hex = ACCESS_CODE_HASH.split("$", 1)
        derived = hashlib.scrypt(
            candidate.strip().encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=16384,
            r=8,
            p=1,
        )
        return hmac.compare_digest(derived.hex(), expected_hex)
    except Exception:
        return False


def make_session_token() -> str:
    exp = int(time.time()) + SESSION_TTL_SEC
    payload = f"team:{exp}"
    sig = hmac.new(SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def check_session_token(token: str | None) -> bool:
    if not token or not SESSION_SECRET or "." not in token:
        return False
    try:
        payload, sig = token.rsplit(".", 1)
        expected = hmac.new(SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        _, exp_s = payload.split(":", 1)
        return int(exp_s) > int(time.time())
    except Exception:
        return False


def require_auth(request: Request) -> str:
    token = request.cookies.get(COOKIE_NAME)
    if not check_session_token(token):
        raise HTTPException(status_code=401, detail="Session expirée ou non authentifiée.")
    return "team"


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def row_to_tournee(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "slug": r["slug"],
        "nom": r["nom"],
        "date_debut": r["date_debut"],
        "date_fin": r["date_fin"],
        "statut": r["statut"],
        "nb_luthiers": r["nb_luthiers"],
        "bareme": json.loads(r["bareme_json"]),
        "frais_estimes": json.loads(r["frais_json"]),
        "notes": r["notes"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def row_to_demande(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    d["adresse_verifiee"] = bool(d["adresse_verifiee"])
    d["creneau_epingle"] = bool(d["creneau_epingle"])
    return d


def row_to_anomalie(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    d["resolue"] = bool(d["resolue"])
    return d


def normalize_phone_digits(raw: str) -> str:
    if not raw:
        return ""
    d = re.sub(r"[^\d+]", "", raw)
    if d.startswith("00"):
        d = "+" + d[2:]
    if d.startswith("0") and len(d) == 10:
        d = "33" + d[1:]
    elif d.startswith("0") and len(d) == 9:
        d = "32" + d[1:]
    d = re.sub(r"\D", "", d)
    return d if len(d) >= 9 else ""


def find_unauthorized_phones(text: str) -> list[str]:
    bad: list[str] = []
    for m in FR_MOBILE_REGEX.findall(text or ""):
        d = re.sub(r"\D", "", m)
        if d.startswith("00"):
            d = d[2:]
        if d.startswith("0") and len(d) == 10:
            d = "33" + d[1:]
        if d != ANTHONY_DIGITS:
            bad.append(m)
    return bad


def run_sync_cycle(include_wacli: bool = True, include_gmail: bool = True) -> int:
    """Remonte SMS + WhatsApp (pianissimo.db ro) + Gmail ciblé vers tournees.db. 0 token LLM."""
    added = 0
    if include_wacli and WACLI_SYNC_SCRIPT.exists():
        try:
            subprocess.run(
                ["/usr/bin/python3", str(WACLI_SYNC_SCRIPT)],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except Exception:
            pass

    with get_db() as tconn:
        active_tours = tconn.execute(
            "SELECT id FROM tournees WHERE statut IN ('en_preparation', 'en_cours')"
        ).fetchall()
        tour_ids = [r["id"] for r in active_tours]
        if not tour_ids:
            return 0

        placeholders = ",".join("?" for _ in tour_ids)
        demandes = tconn.execute(
            f"SELECT id, tournee_id, nom, telephone, email FROM demandes WHERE tournee_id IN ({placeholders})",
            tour_ids,
        ).fetchall()

        phone_map: dict[str, tuple[str, str, str]] = {}
        email_map: dict[str, tuple[str, str, str]] = {}
        for d in demandes:
            for num in re.findall(r"\+?[0-9][0-9\s]{7,}", d["telephone"] or ""):
                dg = re.sub(r"\D", "", num)
                if len(dg) >= 8:
                    phone_map[dg[-9:]] = (d["id"], d["tournee_id"], d["nom"])
            if d["email"]:
                for em in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", d["email"]):
                    email_map[em.lower()] = (d["id"], d["tournee_id"], d["nom"])

        now = now_iso()

        # 1. SMS + WhatsApp depuis pianissimo.db en lecture seule
        if PIANISSIMO_DB.exists() and phone_map:
            pconn = sqlite3.connect(f"file:{PIANISSIMO_DB}?mode=ro", uri=True, timeout=10)
            try:
                for suffix, (dem_id, t_id, dem_nom) in phone_map.items():
                    # WhatsApp
                    wa_rows = pconn.execute(
                        """SELECT ts, from_me, text FROM whatsapp
                           WHERE replace(replace(phone, '+', ''), ' ', '') LIKE ?
                             AND ts >= '2026-10-01'
                           ORDER BY ts DESC LIMIT 20""",
                        (f"%{suffix}",),
                    ).fetchall()
                    for ts, from_me, txt in wa_rows:
                        if not txt:
                            continue
                        ts_iso = f"{ts}T09:00:00+01:00" if len(ts) == 10 else (ts.replace(" ", "T") + "+01:00" if " " in ts and "T" not in ts else ts)
                        direction = "sortant" if from_me else "entrant"
                        auteur = "Pianissimo" if from_me else dem_nom
                        h = hashlib.sha256(f"{dem_id}|WA|{ts_iso}|{direction}|{txt}".encode()).hexdigest()[:24]
                        cur = tconn.execute(
                            """INSERT OR IGNORE INTO messages_historique
                               (id, demande_id, tournee_id, canal, direction, horodatage, contenu, auteur, external_hash, created_at, updated_at)
                               VALUES (?, ?, ?, 'WhatsApp', ?, ?, ?, ?, ?, ?, ?)""",
                            (str(uuid.uuid4()), dem_id, t_id, direction, ts_iso, txt, auteur, h, now, now),
                        )
                        added += cur.rowcount

                    # SMS
                    sms_rows = pconn.execute(
                        """SELECT date_ms, type, corps FROM sms_backup
                           WHERE replace(replace(numero, '+', ''), ' ', '') LIKE ?
                           ORDER BY date_ms DESC LIMIT 15""",
                        (f"%{suffix}",),
                    ).fetchall()
                    for date_ms, sms_type, corps in sms_rows:
                        if not corps or not date_ms:
                            continue
                        ts_iso = datetime.fromtimestamp(int(date_ms) / 1000, tz=timezone.utc).isoformat()
                        direction = "sortant" if int(sms_type or 1) == 2 else "entrant"
                        auteur = "Pianissimo" if direction == "sortant" else dem_nom
                        h = hashlib.sha256(f"{dem_id}|SMS|{date_ms}|{direction}|{corps}".encode()).hexdigest()[:24]
                        cur = tconn.execute(
                            """INSERT OR IGNORE INTO messages_historique
                               (id, demande_id, tournee_id, canal, direction, horodatage, contenu, auteur, external_hash, created_at, updated_at)
                               VALUES (?, ?, ?, 'SMS', ?, ?, ?, ?, ?, ?, ?)""",
                            (str(uuid.uuid4()), dem_id, t_id, direction, ts_iso, corps, auteur, h, now, now),
                        )
                        added += cur.rowcount
            finally:
                pconn.close()

        # 2. Gmail ciblé sur les adresses email des demandes actives
        if include_gmail and GOOGLE_API_SCRIPT.exists() and email_map:
            addresses = sorted(email_map.keys())[:25]
            query_part = " OR ".join(f"from:{a} OR to:{a}" for a in addresses)
            query = f"newer_than:3d ({query_part})"
            env = {**os.environ, "HERMES_HOME": ANTHONY_HERMES_HOME}
            try:
                proc = subprocess.run(
                    ["/usr/bin/python3", str(GOOGLE_API_SCRIPT), "gmail", "search", query, "--max", "15"],
                    capture_output=True,
                    text=True,
                    timeout=25,
                    env=env,
                    check=False,
                )
                if proc.returncode == 0 and proc.stdout.strip().startswith("["):
                    mails = json.loads(proc.stdout)
                    for m in mails:
                        from_s = (m.get("from") or "").lower()
                        to_s = (m.get("to") or "").lower()
                        matched = None
                        direction = "entrant"
                        for addr, info in email_map.items():
                            if addr in from_s:
                                matched = info
                                direction = "entrant"
                                break
                            if addr in to_s:
                                matched = info
                                direction = "sortant"
                                break
                        if not matched:
                            continue
                        dem_id, t_id, dem_nom = matched
                        try:
                            dt_parsed = email.utils.parsedate_to_datetime(m.get("date") or "")
                            ts_iso = dt_parsed.isoformat()
                        except Exception:
                            ts_iso = now
                        subj = (m.get("subject") or "").strip()
                        snip = (m.get("snippet") or "").strip()
                        contenu = f"[{subj}] {snip}".strip() if subj else snip
                        if not contenu:
                            continue
                        auteur = "Pianissimo (Gmail)" if direction == "sortant" else dem_nom
                        h = hashlib.sha256(f"{dem_id}|EMAIL|{m.get('id')}".encode()).hexdigest()[:24]
                        cur = tconn.execute(
                            """INSERT OR IGNORE INTO messages_historique
                               (id, demande_id, tournee_id, canal, direction, horodatage, contenu, auteur, external_hash, created_at, updated_at)
                               VALUES (?, ?, ?, 'Email', ?, ?, ?, ?, ?, ?, ?)""",
                            (str(uuid.uuid4()), dem_id, t_id, direction, ts_iso, contenu, auteur, h, now, now),
                        )
                        added += cur.rowcount
            except Exception:
                pass

    if added > 0:
        broadcast_event("messages_historique")
    return added


async def background_collector() -> None:
    tick = 0
    while True:
        await asyncio.sleep(45)
        tick += 1
        try:
            async with SYNC_LOCK:
                include_wacli = (tick % 3 == 0)   # ~2 min 15 s
                include_gmail = (tick % 4 == 0)   # ~3 min
                await asyncio.to_thread(run_sync_cycle, include_wacli, include_gmail)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    task = asyncio.create_task(background_collector())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Pianissimo Tournées Harpe", lifespan=lifespan)


class LoginBody(BaseModel):
    code: str


class TourneeCreate(BaseModel):
    slug: str
    nom: str
    date_debut: str
    date_fin: str
    statut: str = "en_preparation"
    nb_luthiers: int = 2
    bareme: dict[str, Any] | None = None
    frais_estimes: dict[str, Any] | None = None
    notes: str = ""


class BrouillonBody(BaseModel):
    demande_id: str
    tournee_id: str
    canal: str = "WhatsApp"
    objet: str = ""
    texte_final: str
    statut: str = "brouillon"


class MessageLogBody(BaseModel):
    demande_id: str
    tournee_id: str
    canal: str
    direction: str
    contenu: str
    auteur: str = ""


class MessageSendBody(BaseModel):
    demande_id: str
    canal: str
    objet: str = ""
    texte: str


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/auth/login")
def api_login(body: LoginBody, request: Request, response: Response):
    ip = client_ip(request)
    now = time.time()
    recent = [t for t in LOGIN_FAILURES.get(ip, []) if now - t < LOGIN_WINDOW_SEC]
    if len(recent) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Trop de tentatives. Réessayez dans 15 minutes.")

    if not verify_access_code(body.code):
        recent.append(now)
        LOGIN_FAILURES[ip] = recent
        time.sleep(0.35)
        raise HTTPException(status_code=401, detail="Code d'accès incorrect.")

    LOGIN_FAILURES.pop(ip, None)
    token = make_session_token()
    is_https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_SEC,
        httponly=True,
        secure=is_https,
        samesite="lax",
        path="/",
    )
    return {"ok": True}


@app.get("/api/auth/me")
def api_me(request: Request):
    return {"authenticated": check_session_token(request.cookies.get(COOKIE_NAME))}


@app.post("/api/auth/logout")
def api_logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/tournees")
def list_tournees(_auth: str = Depends(require_auth)):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM tournees ORDER BY date_debut ASC").fetchall()
        return [row_to_tournee(r) for r in rows]


@app.post("/api/tournees")
def create_tournee(body: TourneeCreate, _auth: str = Depends(require_auth)):
    tid = str(uuid.uuid4())
    now = now_iso()
    bareme = body.bareme or {"concert_eur": 320, "concert_h": 2.5, "etude_eur": 280, "etude_h": 2.0, "celtique_eur": 150, "celtique_h": 0.75}
    frais = body.frais_estimes or {"location_voiture": 300, "carburant_peages": 180, "train_approche": 80, "hotel_nuit": 90, "nb_nuits": 5}
    with get_db() as conn:
        conn.execute(
            """INSERT INTO tournees (id, slug, nom, date_debut, date_fin, statut, nb_luthiers, bareme_json, frais_json, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (tid, body.slug, body.nom, body.date_debut, body.date_fin, body.statut, body.nb_luthiers, json.dumps(bareme), json.dumps(frais), body.notes, now, now),
        )
        row = conn.execute("SELECT * FROM tournees WHERE id = ?", (tid,)).fetchone()
    broadcast_event("tournees")
    return row_to_tournee(row)


@app.patch("/api/tournees/{tournee_id}")
async def update_tournee(tournee_id: str, request: Request, _auth: str = Depends(require_auth)):
    payload = await request.json()
    allowed = {"nom", "date_debut", "date_fin", "statut", "nb_luthiers", "notes"}
    updates: list[str] = []
    values: list[Any] = []
    for k, v in payload.items():
        if k in allowed:
            updates.append(f"{k} = ?")
            values.append(v)
        elif k == "bareme":
            updates.append("bareme_json = ?")
            values.append(json.dumps(v))
        elif k == "frais_estimes":
            updates.append("frais_json = ?")
            values.append(json.dumps(v))
    if not updates:
        raise HTTPException(status_code=400, detail="Aucun champ valide.")
    updates.append("updated_at = ?")
    values.extend([now_iso(), tournee_id])
    with get_db() as conn:
        conn.execute(f"UPDATE tournees SET {', '.join(updates)} WHERE id = ?", values)
        row = conn.execute("SELECT * FROM tournees WHERE id = ?", (tournee_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Tournée introuvable.")
    broadcast_event("tournees")
    return row_to_tournee(row)


@app.get("/api/tournees/{tournee_id}/bundle")
def tournee_bundle(tournee_id: str, _auth: str = Depends(require_auth)):
    with get_db() as conn:
        dem = conn.execute(
            "SELECT * FROM demandes WHERE tournee_id = ? ORDER BY (jour_date IS NULL), jour_date ASC, ordre_jour ASC, nom ASC",
            (tournee_id,),
        ).fetchall()
        msg = conn.execute(
            "SELECT * FROM messages_historique WHERE tournee_id = ? ORDER BY horodatage ASC",
            (tournee_id,),
        ).fetchall()
        bro = conn.execute(
            "SELECT * FROM brouillons_messages WHERE tournee_id = ?",
            (tournee_id,),
        ).fetchall()
        ano = conn.execute(
            "SELECT * FROM anomalies WHERE tournee_id = ? ORDER BY resolue ASC, created_at ASC",
            (tournee_id,),
        ).fetchall()
    return {
        "demandes": [row_to_demande(r) for r in dem],
        "messages": [dict(r) for r in msg],
        "brouillons": [dict(r) for r in bro],
        "anomalies": [row_to_anomalie(r) for r in ano],
    }


DEMANDE_FIELDS = {
    "tournee_id", "external_key", "nom", "categorie", "secteur", "ville", "cp", "pays",
    "adresse", "adresse_verifiee", "latitude", "longitude", "canal_prefere", "telephone", "email",
    "nb_concert", "nb_etude", "nb_celtique", "nb_inconnu", "instruments_detail",
    "duree_estimee_h", "montant_estime_eur", "montant_note", "statut",
    "jour_date", "heure_debut", "ordre_jour", "creneau_epingle",
    "contraintes", "citation_source", "action_requise", "devis_statut", "devis_ref",
}


@app.post("/api/demandes")
async def create_demande(request: Request, _auth: str = Depends(require_auth)):
    payload = await request.json()
    did = str(uuid.uuid4())
    now = now_iso()
    cols = ["id", "created_at", "updated_at"]
    vals: list[Any] = [did, now, now]
    for k, v in payload.items():
        if k in DEMANDE_FIELDS:
            cols.append(k)
            vals.append(int(bool(v)) if k in ("adresse_verifiee", "creneau_epingle") else v)
    qs = ",".join("?" for _ in cols)
    with get_db() as conn:
        conn.execute(f"INSERT INTO demandes ({', '.join(cols)}) VALUES ({qs})", vals)
        row = conn.execute("SELECT * FROM demandes WHERE id = ?", (did,)).fetchone()
    broadcast_event("demandes")
    return row_to_demande(row)


@app.patch("/api/demandes/{demande_id}")
async def update_demande(demande_id: str, request: Request, _auth: str = Depends(require_auth)):
    payload = await request.json()
    updates = []
    vals: list[Any] = []
    for k, v in payload.items():
        if k in DEMANDE_FIELDS:
            updates.append(f"{k} = ?")
            vals.append(int(bool(v)) if k in ("adresse_verifiee", "creneau_epingle") else v)
    if not updates:
        raise HTTPException(status_code=400, detail="Aucun champ valide.")
    updates.append("updated_at = ?")
    vals.extend([now_iso(), demande_id])
    with get_db() as conn:
        conn.execute(f"UPDATE demandes SET {', '.join(updates)} WHERE id = ?", vals)
        row = conn.execute("SELECT * FROM demandes WHERE id = ?", (demande_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Demande introuvable.")
    broadcast_event("demandes")
    return row_to_demande(row)


@app.delete("/api/demandes/{demande_id}")
def delete_demande(demande_id: str, _auth: str = Depends(require_auth)):
    with get_db() as conn:
        conn.execute("DELETE FROM demandes WHERE id = ?", (demande_id,))
    broadcast_event("demandes")
    return {"ok": True}


@app.patch("/api/anomalies/{anomalie_id}")
async def update_anomalie(anomalie_id: str, request: Request, _auth: str = Depends(require_auth)):
    payload = await request.json()
    resolue = 1 if payload.get("resolue") else 0
    with get_db() as conn:
        conn.execute("UPDATE anomalies SET resolue = ?, updated_at = ? WHERE id = ?", (resolue, now_iso(), anomalie_id))
    broadcast_event("anomalies")
    return {"ok": True}


@app.put("/api/brouillons")
def upsert_brouillon(body: BrouillonBody, _auth: str = Depends(require_auth)):
    now = now_iso()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO brouillons_messages (id, demande_id, tournee_id, canal, objet, texte_propose, texte_final, statut, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (demande_id, canal) DO UPDATE SET
                 objet = excluded.objet,
                 texte_final = excluded.texte_final,
                 statut = excluded.statut,
                 updated_at = excluded.updated_at""",
            (str(uuid.uuid4()), body.demande_id, body.tournee_id, body.canal, body.objet, body.texte_final, body.texte_final, body.statut, now, now),
        )
    broadcast_event("brouillons_messages")
    return {"ok": True}


@app.post("/api/messages")
def create_message(body: MessageLogBody, _auth: str = Depends(require_auth)):
    now = now_iso()
    with get_db() as conn:
        conn.execute(
            """INSERT INTO messages_historique (id, demande_id, tournee_id, canal, direction, horodatage, contenu, auteur, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (str(uuid.uuid4()), body.demande_id, body.tournee_id, body.canal, body.direction, now, body.contenu, body.auteur, now, now),
        )
    broadcast_event("messages_historique")
    return {"ok": True}


@app.post("/api/sync/messages")
async def sync_messages_now(_auth: str = Depends(require_auth)):
    async with SYNC_LOCK:
        added = await asyncio.to_thread(run_sync_cycle, True, True)
    return {"ok": True, "added": added}


@app.post("/api/messages/send")
def send_message_direct(body: MessageSendBody, _auth: str = Depends(require_auth)):
    texte = (body.texte or "").strip()
    if not texte:
        raise HTTPException(status_code=400, detail="Le message est vide.")

    bad_phones = find_unauthorized_phones(texte)
    if bad_phones:
        raise HTTPException(status_code=400, detail=f"Numéro non autorisé dans le texte : {', '.join(bad_phones)}")

    with get_db() as conn:
        dem = conn.execute("SELECT * FROM demandes WHERE id = ?", (body.demande_id,)).fetchone()
        if not dem:
            raise HTTPException(status_code=404, detail="Client introuvable.")

        if body.canal == "WhatsApp":
            tel = normalize_phone_digits(dem["telephone"])
            if not tel:
                raise HTTPException(status_code=400, detail="Numéro WhatsApp client invalide ou absent.")
            proc = subprocess.run(
                [WACLI_BIN, "send", "text", "--to", tel, "--message", texte, "--json"],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            ok = False
            try:
                last_line = proc.stdout.strip().splitlines()[-1]
                ok = bool(json.loads(last_line).get("success"))
            except Exception:
                ok = proc.returncode == 0
            if not ok:
                err_msg = (proc.stderr or proc.stdout or "Échec wacli")[-200:]
                raise HTTPException(status_code=502, detail=f"Envoi WhatsApp échoué : {err_msg}")

        elif body.canal == "Email":
            dest = (dem["email"] or "").strip()
            if not dest:
                raise HTTPException(status_code=400, detail="Adresse email client absente.")
            subject = (body.objet or f"Tournée harpes Pianissimo — {dem['nom']}").strip()
            env = {**os.environ, "HERMES_HOME": ANTHONY_HERMES_HOME}
            proc = subprocess.run(
                [
                    "/usr/bin/python3",
                    str(GOOGLE_API_SCRIPT),
                    "gmail",
                    "send",
                    "--to",
                    dest,
                    "--subject",
                    subject,
                    "--body",
                    texte,
                ],
                capture_output=True,
                text=True,
                timeout=35,
                env=env,
                check=False,
            )
            if proc.returncode != 0:
                err_msg = (proc.stderr or proc.stdout or "Échec Gmail")[-200:]
                raise HTTPException(status_code=502, detail=f"Envoi Email échoué : {err_msg}")
        else:
            raise HTTPException(status_code=400, detail="Canal non supporté pour l'envoi direct.")

        now = now_iso()
        conn.execute(
            """INSERT INTO brouillons_messages (id, demande_id, tournee_id, canal, objet, texte_propose, texte_final, statut, valide_par, envoye_le, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'envoye', 'equipe', ?, ?, ?)
               ON CONFLICT (demande_id, canal) DO UPDATE SET
                 objet = excluded.objet,
                 texte_final = excluded.texte_final,
                 statut = 'envoye',
                 envoye_le = excluded.envoye_le,
                 updated_at = excluded.updated_at""",
            (str(uuid.uuid4()), dem["id"], dem["tournee_id"], body.canal, body.objet, texte, texte, now, now, now),
        )
        conn.execute(
            """INSERT INTO messages_historique (id, demande_id, tournee_id, canal, direction, horodatage, contenu, auteur, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'sortant', ?, ?, 'Pianissimo (compte pro)', ?, ?)""",
            (str(uuid.uuid4()), dem["id"], dem["tournee_id"], body.canal, now, texte, now, now),
        )

    broadcast_event("messages_historique")
    return {"ok": True}


@app.get("/api/events")
async def sse_events(request: Request, _auth: str = Depends(require_auth)):
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=24)
    SSE_CLIENTS.add(q)

    async def gen():
        try:
            yield "data: connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"data: {ev}\n\n"
                except asyncio.TimeoutError:
                    yield "data: ping\n\n"
        finally:
            SSE_CLIENTS.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


if PUBLIC_DIR.exists():
    @app.get("/")
    def serve_index():
        return FileResponse(str(PUBLIC_DIR / "index.html"), headers={"Cache-Control": "no-cache"})

    @app.get("/sw.js")
    def serve_sw():
        return FileResponse(str(PUBLIC_DIR / "sw.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})

    app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")
