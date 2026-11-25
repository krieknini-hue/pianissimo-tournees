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
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
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
ABBY_ENV_PATH = Path(os.environ.get("ABBY_ENV_PATH", str(Path(ANTHONY_HERMES_HOME) / ".env")))
ABBY_MCP_URL = os.environ.get("ABBY_MCP_URL", "https://api.abby.fr/mcp")
PIANISSIMO_CALENDAR_ID = os.environ.get("PIANISSIMO_CALENDAR_ID", "anthony.accordeur@gmail.com")
WACLI_BIN = os.environ.get("WACLI_BIN", "/usr/local/bin/wacli")

DEFAULT_BAREME = {
    "concert_eur": 320,
    "concert_h": 2.5,
    "etude_eur": 280,
    "etude_h": 2.0,
    "reprise_eur": 160,
    "reprise_h": 1.0,
    "celtique_eur": 150,
    "celtique_h": 0.75,
}

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
        for alter_sql in (
            "ALTER TABLE demandes ADD COLUMN nb_reprise INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE demandes ADD COLUMN devis_abby_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE demandes ADD COLUMN devis_abby_statut TEXT NOT NULL DEFAULT ''",
        ):
            try:
                conn.execute(alter_sql)
            except sqlite3.OperationalError:
                pass


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
    raw_bareme = json.loads(r["bareme_json"] or "{}")
    return {
        "id": r["id"],
        "slug": r["slug"],
        "nom": r["nom"],
        "date_debut": r["date_debut"],
        "date_fin": r["date_fin"],
        "statut": r["statut"],
        "nb_luthiers": r["nb_luthiers"],
        "bareme": {**DEFAULT_BAREME, **raw_bareme},
        "frais_estimes": json.loads(r["frais_json"] or "{}"),
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


class AbbyDevisDraftBody(BaseModel):
    demande_id: str
    lines: list[dict[str, Any]] | None = None
    title: str | None = None
    customer_id: str | None = None
    customer_payload: dict[str, Any] | None = None
    update_existing_billing_address: bool = False


class AbbyDevisActionBody(BaseModel):
    demande_id: str


class AbbyDevisSendBody(BaseModel):
    demande_id: str
    canal: str = "Email"
    objet: str = ""
    texte: str = ""


class CalendarSyncBody(BaseModel):
    dry_run: bool = False
    slots: list[dict[str, Any]] | None = None


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
    bareme = {**DEFAULT_BAREME, **(body.bareme or {})}
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
    "nb_concert", "nb_etude", "nb_reprise", "nb_celtique", "nb_inconnu", "instruments_detail",
    "duree_estimee_h", "montant_estime_eur", "montant_note", "statut",
    "jour_date", "heure_debut", "ordre_jour", "creneau_epingle",
    "contraintes", "citation_source", "action_requise", "devis_statut", "devis_ref",
    "devis_abby_id", "devis_abby_statut",
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


# ---------------------------------------------------------------------------
# Intégration Abby MCP (Devis brouillon -> PDF -> finalisation -> envoi)
# ---------------------------------------------------------------------------

def _read_abby_api_key() -> str:
    env_key = os.environ.get("ABBY_API_KEY", "").strip()
    if env_key:
        return env_key
    if ABBY_ENV_PATH.exists():
        for line in ABBY_ENV_PATH.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("ABBY_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise HTTPException(status_code=500, detail="Clé ABBY_API_KEY introuvable.")


def _strip_accents_lower(s: str) -> str:
    nfd = unicodedata.normalize("NFD", str(s or ""))
    return "".join(ch for ch in nfd if unicodedata.category(ch) != "Mn").lower().strip()


def abby_mcp_call(tool_name: str, arguments: dict[str, Any]) -> Any:
    key = _read_abby_api_key()
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool_name, "arguments": arguments}}
    req = urllib.request.Request(ABBY_MCP_URL, data=json.dumps(payload).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="ignore")[:240]
        raise HTTPException(status_code=502, detail=f"Abby HTTP {exc.code} ({tool_name}): {err_body}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Erreur réseau Abby ({tool_name}): {exc}") from exc

    for ln in raw.splitlines():
        if ln.startswith("data:"):
            raw = ln[5:].strip()
    try:
        rpc = json.loads(raw)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Réponse Abby illisible ({tool_name}): {raw[:160]}") from exc

    if "error" in rpc:
        raise HTTPException(status_code=502, detail=f"Abby {tool_name}: {rpc['error']}")
    result = rpc.get("result") or {}
    if result.get("isError"):
        txt = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        raise HTTPException(status_code=502, detail=f"Abby {tool_name}: {txt[:240]}")

    txt = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text").strip()
    if not txt:
        return result
    try:
        parsed = json.loads(txt)
        if isinstance(parsed, str):
            try:
                return json.loads(parsed)
            except Exception:
                return parsed
        return parsed
    except Exception:
        return txt


_ABBY_CUSTOMERS_CACHE: dict[str, Any] = {"ts": 0.0, "items": []}
ABBY_CUSTOMERS_CACHE_TTL = 45.0

ORG_CATEGORIES = ("conservatoire", "academie", "opera")
ORG_KEYWORDS = (
    "conservatoire",
    "academie",
    "ecole",
    "opera",
    "crr",
    "crd",
    "crc",
    "orchestre",
    "institut",
)
ORG_STOPWORDS = {
    "conservatoire",
    "academie",
    "ecole",
    "musique",
    "opera",
    "royal",
    "royale",
    "de",
    "du",
    "des",
    "d",
    "l",
    "la",
    "le",
    "les",
    "et",
    "ville",
    "entite",
    "admin",
    "crr",
    "crd",
    "crc",
    "danse",
    "regional",
    "rayonnement",
}
CIVILITY_PREFIX_RE = re.compile(r"^(?:m\.|mr\.?|mme\.?|mlle\.?|madame|monsieur|dr\.?)\s+", re.IGNORECASE)
TRAIL_ZIP_CITY_RE = re.compile(r",?\s*\b(\d{4,5})\s+([A-Za-zÀ-ÖØ-öø-ÿ'’\- ]+(?:\([^)]*\))?)$")
ADDR_HINT_RE = re.compile(
    r"(factur|adresse|\brue\b|\bavenue\b|\bboulevard\b|\bplace\b|\ball[ée]e\b|\bimpasse\b|\bchemin\b|\broute\b|\bstraat\b|\blaan\b|\bsquare\b|\bquai\b|\b\d{4,5}\s+[A-Za-zÀ-ÖØ-öø-ÿ]{2,})",
    re.IGNORECASE,
)
EMAIL_VALID_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _invalidate_abby_customers_cache() -> None:
    _ABBY_CUSTOMERS_CACHE["ts"] = 0.0
    _ABBY_CUSTOMERS_CACHE["items"] = []


def fetch_all_abby_customers(force_refresh: bool = False) -> list[dict[str, Any]]:
    now = time.time()
    cached = _ABBY_CUSTOMERS_CACHE.get("items") or []
    if not force_refresh and cached and (now - float(_ABBY_CUSTOMERS_CACHE.get("ts") or 0.0)) < ABBY_CUSTOMERS_CACHE_TTL:
        return cached

    all_items: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    page = 1
    while page <= 30:
        res = abby_mcp_call("get-customers", {"page": page, "limit": 100})
        items = res.get("customers") or res.get("docs") or res.get("items") or (res if isinstance(res, list) else [])
        for c in items:
            if not isinstance(c, dict):
                continue
            cid = str(c.get("id") or c.get("_id") or "")
            if cid and cid in seen_ids:
                continue
            if cid:
                seen_ids.add(cid)
            all_items.append(c)
        if not isinstance(res, dict) or not res.get("hasNextPage"):
            break
        page += 1

    _ABBY_CUSTOMERS_CACHE["ts"] = now
    _ABBY_CUSTOMERS_CACHE["items"] = all_items
    return all_items


def _split_person_name(raw_name: str) -> tuple[str, str]:
    clean = re.sub(r"\([^)]*\)", "", raw_name or "").strip()
    had_civility = False
    while True:
        m = CIVILITY_PREFIX_RE.match(clean)
        if not m:
            break
        had_civility = True
        clean = clean[m.end():].strip()

    tokens = [t for t in clean.split() if t]
    if not tokens:
        return "", ""

    upper_start = None
    for i in range(len(tokens)):
        tail = tokens[i:]
        if all(any(ch.isalpha() for ch in t) and t == t.upper() for t in tail):
            upper_start = i
            break

    if upper_start is not None:
        if upper_start > 0:
            firstname = " ".join(tokens[:upper_start])
            lastname = " ".join(tokens[upper_start:])
        elif had_civility or len(tokens) == 1:
            firstname = ""
            lastname = " ".join(tokens)
        else:
            firstname = tokens[0]
            lastname = " ".join(tokens[1:])
    elif len(tokens) >= 2:
        firstname = tokens[0]
        lastname = " ".join(tokens[1:])
    else:
        firstname = ""
        lastname = tokens[0]

    return firstname.strip().lower(), lastname.strip().upper()


def _country_to_iso2(pays: str, cp: str = "", secteur: str = "") -> str:
    p = _strip_accents_lower(pays or "")
    mapping = {
        "france": "FR",
        "fr": "FR",
        "belgique": "BE",
        "belgium": "BE",
        "belgie": "BE",
        "be": "BE",
        "suisse": "CH",
        "switzerland": "CH",
        "schweiz": "CH",
        "ch": "CH",
        "luxembourg": "LU",
        "lu": "LU",
        "allemagne": "DE",
        "germany": "DE",
        "de": "DE",
        "pays-bas": "NL",
        "pays bas": "NL",
        "netherlands": "NL",
        "nl": "NL",
        "italie": "IT",
        "italy": "IT",
        "it": "IT",
        "espagne": "ES",
        "spain": "ES",
        "es": "ES",
        "royaume-uni": "GB",
        "royaume uni": "GB",
        "uk": "GB",
        "gb": "GB",
    }
    if p in mapping:
        return mapping[p]
    for key, code in mapping.items():
        if len(key) > 2 and key in p:
            return code
    sec = _strip_accents_lower(secteur or "")
    if any(k in sec for k in ("bruxelles", "liege", "alost", "gand", "gent", "namur", "wallonie", "anvers", "charleroi", "mons", "louvain")):
        return "BE"
    if any(k in sec for k in ("suisse", "lausanne", "geneve", "neuchatel", "fribourg", "vevey", "montreux", "valais")):
        return "CH"
    return "FR"


def _extract_client_address_hints(incoming_msgs: list[sqlite3.Row]) -> list[dict[str, str]]:
    hints: list[dict[str, str]] = []
    for m in incoming_msgs:
        if (m["direction"] or "") != "entrant":
            continue
        content = (m["contenu"] or "").strip()
        if not content:
            continue
        if ADDR_HINT_RE.search(content):
            hints.append({
                "date": (m["horodatage"] or "")[:10],
                "canal": str(m["canal"] or ""),
                "extrait": content[:320],
            })
            if len(hints) >= 3:
                break
    return hints


def _extract_billing_address_proposal(dem: sqlite3.Row, incoming_msgs: list[sqlite3.Row]) -> dict[str, Any]:
    raw_adresse = (dem["adresse"] or "").strip()
    cp = (dem["cp"] or "").strip()
    ville = (dem["ville"] or "").strip()
    pays = (dem["pays"] or "").strip()

    low_raw = raw_adresse.lower()
    needs_review = (
        not raw_adresse
        or "à confirmer" in low_raw
        or "a confirmer" in low_raw
        or "à préciser" in low_raw
        or "a preciser" in low_raw
        or "à recevoir" in low_raw
        or "a recevoir" in low_raw
        or "adresse exacte" in low_raw
        or " ou " in low_raw
        or " + " in raw_adresse
        or "pas chez" in low_raw
        or "(carnet" in low_raw
    )

    clean_addr = raw_adresse
    if re.search(r"\s+OU\s+", clean_addr):
        clean_addr = re.split(r"\s+OU\s+", clean_addr, maxsplit=1)[0].strip()
        needs_review = True
    if " + " in clean_addr:
        clean_addr = clean_addr.split(" + ", 1)[0].strip()
        needs_review = True

    clean_addr = re.sub(
        r"\((?:carnet[^)]*|entr[ée]e[^)]*|au choix[^)]*|lieu[^)]*|adresse[^)]*|ou apport[^)]*|orw[^)]*)\)",
        "",
        clean_addr,
        flags=re.IGNORECASE,
    ).strip()

    if any(
        k in clean_addr.lower()
        for k in ("à confirmer", "a confirmer", "à préciser", "a preciser", "à recevoir", "a recevoir", "adresse exacte")
    ):
        clean_addr = ""

    if not clean_addr:
        for m in incoming_msgs:
            if (m["direction"] or "") != "entrant":
                continue
            found = re.search(r"(?:mon\s+)?adresse(?:\s+de\s+facturation)?\s*[:\-]\s*([^\n]+)", m["contenu"] or "", re.IGNORECASE)
            if found:
                clean_addr = found.group(1).strip(" .")
                break

    m_zip_city = TRAIL_ZIP_CITY_RE.search(clean_addr)
    if m_zip_city:
        parsed_zip, parsed_city = m_zip_city.group(1).strip(), m_zip_city.group(2).strip()
        if not cp:
            cp = parsed_zip
        if not ville:
            ville = parsed_city
        clean_addr = clean_addr[:m_zip_city.start()].strip(" ,;")

    return {
        "address": clean_addr.strip(" ,;"),
        "complement": "",
        "zipCode": cp.strip(),
        "city": ville.strip(),
        "country": _country_to_iso2(pays, cp, dem["secteur"] or ""),
        "raw_source": raw_adresse,
        "needs_review": bool(needs_review or not clean_addr.strip() or not cp.strip() or not ville.strip()),
    }


def _norm_words(s: str) -> str:
    txt = _strip_accents_lower(s).replace("-", " ").replace("’", "'").replace("'", " ")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", txt)).strip()


def _serialize_abby_customer(cust: dict[str, Any], score: int = 0, reason: str = "") -> dict[str, Any]:
    b_addr = cust.get("billingAddress") or {}
    return {
        "id": str(cust.get("id") or cust.get("_id") or ""),
        "displayName": str(cust.get("displayName") or cust.get("name") or "").strip(),
        "firstname": str(cust.get("firstname") or "").strip(),
        "lastname": str(cust.get("lastname") or "").strip(),
        "name": str(cust.get("name") or "").strip(),
        "isContact": bool(cust.get("isContact")),
        "isOrganization": bool(cust.get("isOrganization")),
        "contactId": str(cust.get("contactId") or ""),
        "organizationId": str(cust.get("organizationId") or ""),
        "phoneNumber": str(cust.get("phoneNumber") or "").strip(),
        "billingAddress": {
            "line1": str(b_addr.get("line1") or "").strip(),
            "line2": str(b_addr.get("line2") or "").strip(),
            "zipCode": str(b_addr.get("zipCode") or "").strip(),
            "city": str(b_addr.get("city") or "").strip(),
            "country": str(b_addr.get("country") or "").strip(),
        },
        "score": score,
        "reason": reason,
    }


def _proposed_org_name(raw_name: str) -> str:
    clean_base = re.sub(r"\([^)]*\)", "", raw_name or "").strip()
    if any(kw in _norm_words(clean_base) for kw in ORG_KEYWORDS):
        return clean_base
    for paren in re.findall(r"\(([^)]*)\)", raw_name or ""):
        if any(kw in _norm_words(paren) for kw in ORG_KEYWORDS):
            return paren.strip()
    return clean_base or (raw_name or "").strip()


def _org_kind_family(norm_text: str) -> set[str]:
    words = set(norm_text.split())
    fams: set[str] = set()
    if words & {"conservatoire", "crr", "crd", "crc"}:
        fams.add("conservatoire")
    if "academie" in words:
        fams.add("academie")
    if words & {"ecole", "institut"}:
        fams.add("ecole")
    if words & {"opera", "orchestre"}:
        fams.add("opera")
    return fams


def find_abby_customer_candidates(
    dem: sqlite3.Row,
    customers: list[dict[str, Any]],
) -> tuple[str, dict[str, Any] | None, list[dict[str, Any]]]:
    raw_name = (dem["nom"] or "").strip()
    target_email = (dem["email"] or "").strip().lower()
    target_tel = normalize_phone_digits(dem["telephone"] or "")
    target_tel9 = target_tel[-9:] if len(target_tel) >= 9 else ""
    dem_cp = (dem["cp"] or "").strip()
    dem_ville_norm = _norm_words(dem["ville"] or "")
    is_org = (dem["categorie"] or "") in ORG_CATEGORIES

    email_match_ids: set[str] = set()
    if target_email and EMAIL_VALID_RE.match(target_email):
        try:
            eres = abby_mcp_call("get-customers", {"search": target_email, "limit": 10})
            eitems = eres.get("customers") or eres.get("docs") or eres.get("items") or (eres if isinstance(eres, list) else [])
            for ec in eitems:
                if isinstance(ec, dict):
                    ecid = str(ec.get("id") or ec.get("_id") or "")
                    if ecid:
                        email_match_ids.add(ecid)
        except Exception:
            pass

    p_first, p_last = _split_person_name(raw_name)
    p_first_n = _norm_words(p_first)
    p_last_n = _norm_words(p_last)
    org_target_n = _norm_words(_proposed_org_name(raw_name))
    org_tokens = [t for t in org_target_n.split() if len(t) >= 3 and t not in ORG_STOPWORDS]

    scored: list[dict[str, Any]] = []
    for cust in customers:
        if not isinstance(cust, dict):
            continue
        cid = str(cust.get("id") or cust.get("_id") or "")
        if not cid:
            continue

        disp_n = _norm_words(str(cust.get("displayName") or cust.get("name") or ""))
        c_first_n = _norm_words(str(cust.get("firstname") or ""))
        c_last_n = _norm_words(str(cust.get("lastname") or ""))
        c_tel = normalize_phone_digits(str(cust.get("phoneNumber") or ""))
        c_tel9 = c_tel[-9:] if len(c_tel) >= 9 else ""
        b_addr = cust.get("billingAddress") or {}
        c_zip = str(b_addr.get("zipCode") or "").strip()
        c_city_n = _norm_words(str(b_addr.get("city") or ""))

        score = 0
        reasons: list[str] = []

        if cid in email_match_ids:
            score = max(score, 100)
            reasons.append("email identique")
        if target_tel9 and c_tel9 and c_tel9 == target_tel9:
            score = max(score, 95)
            reasons.append("téléphone identique")

        if not is_org:
            full_1 = f"{p_first_n} {p_last_n}".strip()
            full_2 = f"{p_last_n} {p_first_n}".strip()
            if full_1 and (disp_n == full_1 or disp_n == full_2):
                score = max(score, 92)
                reasons.append("nom et prénom identiques")
            elif p_last_n and (
                c_last_n == p_last_n or bool(re.search(rf"\b{re.escape(p_last_n)}\b", disp_n))
            ):
                if p_first_n and (
                    c_first_n == p_first_n or bool(re.search(rf"\b{re.escape(p_first_n)}\b", disp_n))
                ):
                    score = max(score, 88)
                    reasons.append("nom et prénom concordants")
                elif len(p_last_n) >= 4 and (c_last_n == p_last_n or (not c_last_n and p_last_n in disp_n.split())):
                    if dem_cp and c_zip and dem_cp == c_zip:
                        score = max(score, 82)
                        reasons.append("nom + code postal identiques")
                    else:
                        score = max(score, 58)
                        reasons.append("même nom de famille")
        else:
            disp_is_org = bool(cust.get("isOrganization")) or any(kw in disp_n.split() for kw in ORG_KEYWORDS)
            t_fams = _org_kind_family(org_target_n)
            d_fams = _org_kind_family(disp_n)
            same_kind = bool(t_fams & d_fams)
            kind_conflict = bool(t_fams and d_fams and not same_kind)

            if org_target_n and disp_n == org_target_n:
                score = max(score, 92)
                reasons.append("établissement identique")
            elif disp_is_org and org_tokens:
                matched_toks = [t for t in org_tokens if re.search(rf"\b{re.escape(t)}\b", disp_n)]
                if matched_toks and (
                    len(matched_toks) == len(org_tokens)
                    or (len(matched_toks) >= 1 and len(matched_toks[0]) >= 5)
                ):
                    same_loc = (dem_cp and c_zip and dem_cp == c_zip) or (
                        dem_ville_norm and c_city_n and (c_city_n in dem_ville_norm or dem_ville_norm in c_city_n)
                    )
                    if kind_conflict:
                        if same_loc:
                            score = max(score, 55)
                            reasons.append("autre établissement même ville")
                    elif same_kind and same_loc:
                        score = max(score, 90)
                        reasons.append("établissement & ville concordants")
                    elif same_loc and len(matched_toks) == len(org_tokens):
                        score = max(score, 72)
                        reasons.append("établissement proche à confirmer")
                    elif same_kind:
                        score = max(score, 68)
                        reasons.append("établissement proche")

            # Candidat contact individuel rattaché dans l'intitulé (ex. professeure / contact)
            raw_base_has_org = any(kw in _norm_words(re.sub(r"\([^)]*\)", "", raw_name)) for kw in ORG_KEYWORDS)
            if not cust.get("isOrganization") and not raw_base_has_org and p_last_n and len(p_last_n) >= 4 and (
                c_last_n == p_last_n or bool(re.search(rf"\b{re.escape(p_last_n)}\b", disp_n))
            ):
                if p_first_n and (c_first_n == p_first_n or bool(re.search(rf"\b{re.escape(p_first_n)}\b", disp_n))):
                    score = max(score, 60)
                    reasons.append("contact référent existant")

        if score >= 50:
            scored.append(_serialize_abby_customer(cust, score=score, reason=", ".join(reasons)))

    scored.sort(key=lambda x: (-x["score"], x["displayName"]))
    top = scored[:6]
    if top and top[0]["score"] >= 80:
        return "found", top[0], top
    if top:
        return "candidates", None, top
    return "not_found", None, []


def _normalize_billing_address_input(addr: dict[str, Any]) -> dict[str, str]:
    line1 = str(addr.get("address") or addr.get("line1") or "").strip()
    complement = str(addr.get("complement") or addr.get("line2") or "").strip()
    zip_code = str(addr.get("zipCode") or "").strip()
    city = str(addr.get("city") or "").strip()
    country = _country_to_iso2(str(addr.get("country") or "FR"))
    if not line1 or not zip_code or not city or not country:
        raise HTTPException(
            status_code=400,
            detail="Adresse de facturation incomplète (rue, code postal, ville et pays obligatoires).",
        )
    out = {
        "address": line1,
        "zipCode": zip_code,
        "city": city,
        "country": country,
    }
    if complement:
        out["complement"] = complement
    return out


def _create_abby_customer_strict(dem: sqlite3.Row, cust_payload: dict[str, Any]) -> tuple[str, str]:
    is_org_default = (dem["categorie"] or "") in ORG_CATEGORIES
    kind = str(cust_payload.get("kind") or ("organization" if is_org_default else "contact")).strip()
    billing_addr = _normalize_billing_address_input(cust_payload.get("billingAddress") or {})
    email_val = str(cust_payload.get("email") or dem["email"] or "").strip()
    phone_val = str(cust_payload.get("phone") or dem["telephone"] or "").strip()

    if kind == "organization":
        org_name = str(cust_payload.get("name") or _proposed_org_name(dem["nom"] or "")).strip()
        if not org_name:
            raise HTTPException(status_code=400, detail="Nom de l'établissement obligatoire pour créer la fiche Abby.")
        notes = f"Tournée harpe ({dem['secteur']})"
        if phone_val:
            notes += f" · Tél : {phone_val}"
        payload: dict[str, Any] = {
            "name": org_name,
            "billingAddress": billing_addr,
            "notes": notes,
        }
        if email_val and EMAIL_VALID_RE.match(email_val):
            payload["emails"] = [email_val]
        abby_mcp_call("create-organization", payload)
        expected_norm = _norm_words(org_name)
    else:
        raw_first = str(cust_payload.get("firstname") or "").strip()
        raw_last = str(cust_payload.get("lastname") or "").strip()
        if not raw_first and not raw_last:
            raw_first, raw_last = _split_person_name(dem["nom"] or "")
        firstname = raw_first.lower()
        lastname = raw_last.upper()
        if not firstname or not lastname:
            raise HTTPException(
                status_code=400,
                detail="Prénom (en minuscules) et NOM (en majuscules) obligatoires pour créer la fiche client dans Abby.",
            )
        payload = {
            "firstname": firstname,
            "lastname": lastname,
            "billingAddress": billing_addr,
            "notes": f"Tournée harpe ({dem['secteur']})",
        }
        if email_val and EMAIL_VALID_RE.match(email_val):
            payload["emails"] = [email_val]
        if phone_val:
            payload["phone"] = phone_val
        abby_mcp_call("create-contact", payload)
        expected_norm = _norm_words(f"{firstname} {lastname}")

    _invalidate_abby_customers_cache()
    refreshed = fetch_all_abby_customers(force_refresh=True)
    target_zip = billing_addr["zipCode"]
    fallback_match: tuple[str, str] | None = None
    for c in refreshed:
        disp_n = _norm_words(str(c.get("displayName") or c.get("name") or ""))
        c_first_n = _norm_words(str(c.get("firstname") or ""))
        c_last_n = _norm_words(str(c.get("lastname") or ""))
        combined_n = f"{c_first_n} {c_last_n}".strip()
        if disp_n == expected_norm or (combined_n and combined_n == expected_norm):
            cid = str(c.get("id") or c.get("_id") or "")
            cname = str(c.get("displayName") or c.get("name") or "")
            if cid:
                c_zip = str((c.get("billingAddress") or {}).get("zipCode") or "").strip()
                if c_zip == target_zip:
                    return cid, cname
                fallback_match = (cid, cname)
    if fallback_match:
        return fallback_match

    raise HTTPException(status_code=502, detail="Fiche créée dans Abby mais customerId introuvable après relecture.")


def _update_existing_abby_billing_address(existing_cust: dict[str, Any], billing_addr_in: dict[str, Any]) -> None:
    billing_addr = _normalize_billing_address_input(billing_addr_in)
    if existing_cust.get("isContact") and existing_cust.get("contactId"):
        firstname = str(existing_cust.get("firstname") or "").strip()
        lastname = str(existing_cust.get("lastname") or "").strip()
        if not firstname or not lastname:
            raise HTTPException(status_code=400, detail="Impossible de mettre à jour ce contact Abby (prénom/nom manquants).")
        abby_mcp_call(
            "update-contact",
            {
                "contactId": str(existing_cust["contactId"]),
                "firstname": firstname,
                "lastname": lastname,
                "billingAddress": billing_addr,
            },
        )
    elif existing_cust.get("isOrganization") and existing_cust.get("organizationId"):
        org_name = str(existing_cust.get("name") or existing_cust.get("displayName") or "").strip()
        if not org_name:
            raise HTTPException(status_code=400, detail="Impossible de mettre à jour cette organisation Abby (nom manquant).")
        abby_mcp_call(
            "update-organization",
            {
                "organizationId": str(existing_cust["organizationId"]),
                "name": org_name,
                "billingAddress": billing_addr,
            },
        )
    else:
        raise HTTPException(status_code=400, detail="Type de fiche Abby non modifiable automatiquement.")
    _invalidate_abby_customers_cache()


def _abby_download_pdf_bytes(billing_id: str) -> bytes:
    dl = abby_mcp_call("download-billing-document", {"billingId": billing_id, "withAttachments": True})
    if not isinstance(dl, dict) or not dl.get("downloadUrl"):
        raise HTTPException(status_code=502, detail="Abby n'a pas renvoyé d'URL PDF.")
    url = str(dl["downloadUrl"])
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.read()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Téléchargement PDF Abby impossible : {exc}") from exc


def _send_gmail_with_pdf(dest: str, subject: str, body_text: str, pdf_bytes: bytes, filename: str) -> None:
    from email.message import EmailMessage
    import base64

    prev_home = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = ANTHONY_HERMES_HOME
    try:
        script_dir = str(GOOGLE_API_SCRIPT.parent)
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)
        import google_api  # type: ignore

        service = google_api.build_service("gmail", "v1")
        msg = EmailMessage()
        msg["To"] = dest
        msg["From"] = PIANISSIMO_CALENDAR_ID
        msg["Subject"] = subject
        msg.set_content(body_text)
        msg.add_attachment(pdf_bytes, maintype="application", subtype="pdf", filename=filename)
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        service.users().messages().send(userId="me", body={"raw": raw}).execute()
    finally:
        if prev_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = prev_home


def _build_proposed_customer(dem: sqlite3.Row, incoming_msgs: list[sqlite3.Row]) -> dict[str, Any]:
    is_org = (dem["categorie"] or "") in ORG_CATEGORIES
    firstname, lastname = _split_person_name(dem["nom"] or "")
    return {
        "kind": "organization" if is_org else "contact",
        "firstname": firstname,
        "lastname": lastname,
        "name": _proposed_org_name(dem["nom"] or ""),
        "email": (dem["email"] or "").strip(),
        "phone": (dem["telephone"] or "").strip(),
        "billingAddress": _extract_billing_address_proposal(dem, incoming_msgs),
    }


@app.get("/api/abby/customer/check")
def check_abby_customer(demande_id: str, _auth: str = Depends(require_auth)):
    with get_db() as conn:
        dem = conn.execute("SELECT * FROM demandes WHERE id = ?", (demande_id,)).fetchone()
        if not dem:
            raise HTTPException(status_code=404, detail="Demande introuvable.")
        incoming_msgs = conn.execute(
            """SELECT canal, direction, horodatage, contenu
               FROM messages_historique
               WHERE demande_id = ? AND direction = 'entrant'
               ORDER BY horodatage DESC""",
            (demande_id,),
        ).fetchall()

    customers = fetch_all_abby_customers()
    status, matched, candidates = find_abby_customer_candidates(dem, customers)
    return {
        "ok": True,
        "status": status,
        "matched": matched,
        "candidates": candidates,
        "proposed_customer": _build_proposed_customer(dem, incoming_msgs),
        "client_address_hints": _extract_client_address_hints(incoming_msgs),
        "total_abby_customers": len(customers),
    }


@app.get("/api/abby/customers/search")
def search_abby_customers(q: str = "", _auth: str = Depends(require_auth)):
    query = (q or "").strip()
    if not query:
        return {"ok": True, "items": []}

    customers = fetch_all_abby_customers()
    q_norm = _norm_words(query)
    q_digits = normalize_phone_digits(query)
    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    if "@" in query:
        try:
            eres = abby_mcp_call("get-customers", {"search": query, "limit": 15})
            eitems = eres.get("customers") or eres.get("docs") or eres.get("items") or (eres if isinstance(eres, list) else [])
            for ec in eitems:
                if isinstance(ec, dict):
                    item = _serialize_abby_customer(ec, score=100, reason="email")
                    if item["id"] and item["id"] not in seen_ids:
                        seen_ids.add(item["id"])
                        results.append(item)
        except Exception:
            pass

    for c in customers:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or c.get("_id") or "")
        if not cid or cid in seen_ids:
            continue
        b_addr = c.get("billingAddress") or {}
        hay = _norm_words(
            " ".join(
                [
                    str(c.get("displayName") or ""),
                    str(c.get("firstname") or ""),
                    str(c.get("lastname") or ""),
                    str(c.get("name") or ""),
                    str(b_addr.get("city") or ""),
                    str(b_addr.get("zipCode") or ""),
                ]
            )
        )
        c_tel = normalize_phone_digits(str(c.get("phoneNumber") or ""))
        if (q_norm and q_norm in hay) or (q_digits and c_tel and q_digits in c_tel):
            seen_ids.add(cid)
            results.append(_serialize_abby_customer(c, score=80, reason="recherche manuelle"))
            if len(results) >= 15:
                break

    return {"ok": True, "items": results[:15]}


@app.post("/api/abby/devis/draft")
def create_abby_devis_draft(body: AbbyDevisDraftBody, _auth: str = Depends(require_auth)):
    with get_db() as conn:
        dem = conn.execute("SELECT * FROM demandes WHERE id = ?", (body.demande_id,)).fetchone()
        if not dem:
            raise HTTPException(status_code=404, detail="Demande introuvable.")
        tour = conn.execute("SELECT * FROM tournees WHERE id = ?", (dem["tournee_id"],)).fetchone()
        bareme = {**DEFAULT_BAREME, **(json.loads(tour["bareme_json"]) if tour else {})}
        incoming_msgs = conn.execute(
            """SELECT canal, direction, horodatage, contenu
               FROM messages_historique
               WHERE demande_id = ? AND direction = 'entrant'
               ORDER BY horodatage DESC""",
            (body.demande_id,),
        ).fetchall()

        lines_in = body.lines or []
        abby_lines: list[dict[str, Any]] = []
        if lines_in:
            for item in lines_in:
                qty = max(1, int(item.get("quantity", 1)))
                eur = float(item.get("unitPrice_eur", 0))
                des = str(item.get("designation") or "Réglage harpe").strip()
                if des and eur > 0:
                    line_obj: dict[str, Any] = {
                        "designation": des,
                        "unitPrice": round(eur * 100),
                        "quantity": qty,
                        "quantityUnit": "unit",
                        "type": "commercial_or_craft_services",
                        "vatCode": "fr_not_applicable",
                    }
                    if item.get("description"):
                        line_obj["description"] = str(item["description"])
                    abby_lines.append(line_obj)
        else:
            if int(dem["nb_concert"] or 0) > 0:
                abby_lines.append({
                    "designation": "Entretien et réglage complet harpe de concert",
                    "unitPrice": round(float(bareme["concert_eur"]) * 100),
                    "quantity": int(dem["nb_concert"]),
                    "quantityUnit": "unit",
                    "type": "commercial_or_craft_services",
                    "vatCode": "fr_not_applicable",
                })
            if int(dem["nb_etude"] or 0) > 0:
                abby_lines.append({
                    "designation": "Entretien et réglage complet harpe d'étude",
                    "unitPrice": round(float(bareme["etude_eur"]) * 100),
                    "quantity": int(dem["nb_etude"]),
                    "quantityUnit": "unit",
                    "type": "commercial_or_craft_services",
                    "vatCode": "fr_not_applicable",
                })
            if int(dem["nb_reprise"] or 0) > 0:
                abby_lines.append({
                    "designation": "Reprise de réglage harpe à pédales",
                    "unitPrice": round(float(bareme["reprise_eur"]) * 100),
                    "quantity": int(dem["nb_reprise"]),
                    "quantityUnit": "unit",
                    "type": "commercial_or_craft_services",
                    "vatCode": "fr_not_applicable",
                })
            if int(dem["nb_celtique"] or 0) > 0:
                abby_lines.append({
                    "designation": "Entretien et réglage harpe celtique",
                    "unitPrice": round(float(bareme["celtique_eur"]) * 100),
                    "quantity": int(dem["nb_celtique"]),
                    "quantityUnit": "unit",
                    "type": "commercial_or_craft_services",
                    "vatCode": "fr_not_applicable",
                })
            if not abby_lines:
                fallback_eur = float(dem["montant_estime_eur"] or bareme["concert_eur"])
                abby_lines.append({
                    "designation": f"Entretien et réglage de harpe ({dem['instruments_detail'] or 'à préciser'})",
                    "unitPrice": round(fallback_eur * 100),
                    "quantity": 1,
                    "quantityUnit": "unit",
                    "type": "commercial_or_craft_services",
                    "vatCode": "fr_not_applicable",
                })

        if not abby_lines:
            raise HTTPException(status_code=400, detail="Aucune ligne de devis valide (> 0 €).")

        customers = fetch_all_abby_customers()
        customer_created = False
        selected_cid = (body.customer_id or "").strip()
        cust_payload = body.customer_payload or {}

        if selected_cid:
            existing_cust = next(
                (c for c in customers if str(c.get("id") or c.get("_id") or "") == selected_cid),
                None,
            )
            if not existing_cust:
                customers = fetch_all_abby_customers(force_refresh=True)
                existing_cust = next(
                    (c for c in customers if str(c.get("id") or c.get("_id") or "") == selected_cid),
                    None,
                )
            if not existing_cust:
                raise HTTPException(status_code=404, detail="Fiche client Abby sélectionnée introuvable.")
            if body.update_existing_billing_address and cust_payload.get("billingAddress"):
                _update_existing_abby_billing_address(existing_cust, cust_payload["billingAddress"])
            customer_id = selected_cid
            customer_name = str(existing_cust.get("displayName") or existing_cust.get("name") or dem["nom"])
        else:
            force_create = bool(cust_payload.get("force_create"))
            if not force_create:
                status, matched, _ = find_abby_customer_candidates(dem, customers)
                if status == "found" and matched and matched.get("id"):
                    customer_id = str(matched["id"])
                    customer_name = str(matched.get("displayName") or dem["nom"])
                else:
                    proposed = _build_proposed_customer(dem, incoming_msgs)
                    effective_payload = {**proposed, **cust_payload}
                    if cust_payload.get("billingAddress"):
                        effective_payload["billingAddress"] = {
                            **proposed["billingAddress"],
                            **cust_payload["billingAddress"],
                        }
                    customer_id, customer_name = _create_abby_customer_strict(dem, effective_payload)
                    customer_created = True
            else:
                proposed = _build_proposed_customer(dem, incoming_msgs)
                effective_payload = {**proposed, **cust_payload}
                if cust_payload.get("billingAddress"):
                    effective_payload["billingAddress"] = {
                        **proposed["billingAddress"],
                        **cust_payload["billingAddress"],
                    }
                customer_id, customer_name = _create_abby_customer_strict(dem, effective_payload)
                customer_created = True

        create_payload: dict[str, Any] = {
            "customerId": customer_id,
            "estimateType": "estimate",
            "lines": abby_lines,
        }
        if body.title:
            create_payload["title"] = body.title.strip()
        created = abby_mcp_call("create-estimate", create_payload)
        billing_id = ""
        ref = "Brouillon Abby"
        if isinstance(created, dict):
            doc = created.get("billing") or created.get("estimate") or created
            if isinstance(doc, dict):
                billing_id = str(doc.get("id") or doc.get("_id") or created.get("id") or "")
                ref = str(doc.get("number") or "Brouillon Abby")
        if not billing_id:
            raise HTTPException(status_code=502, detail=f"ID devis Abby non retourné : {created}")

        conn.execute(
            """UPDATE demandes
               SET devis_abby_id = ?, devis_abby_statut = 'brouillon', devis_ref = ?,
                   devis_statut = CASE WHEN devis_statut = 'non_requis' THEN 'a_faire' ELSE devis_statut END,
                   updated_at = ?
               WHERE id = ?""",
            (billing_id, ref, now_iso(), dem["id"]),
        )
    broadcast_event("demandes")
    return {
        "ok": True,
        "billing_id": billing_id,
        "ref": ref,
        "customer_id": customer_id,
        "customer_name": customer_name,
        "customer_created": customer_created,
        "pdf_url": f"/api/abby/devis/{billing_id}/pdf",
    }


@app.get("/api/abby/devis/{billing_id}/pdf")
def preview_abby_devis_pdf(billing_id: str, _auth: str = Depends(require_auth)):
    pdf_bytes = _abby_download_pdf_bytes(billing_id)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="devis-pianissimo-{billing_id}.pdf"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/abby/devis/{billing_id}/finalize")
def finalize_abby_devis(billing_id: str, body: AbbyDevisActionBody, _auth: str = Depends(require_auth)):
    with get_db() as conn:
        dem = conn.execute("SELECT * FROM demandes WHERE id = ?", (body.demande_id,)).fetchone()
        if not dem:
            raise HTTPException(status_code=404, detail="Demande introuvable.")

        fin = abby_mcp_call("finalize-billing", {"billingId": billing_id, "confirm": True})
        info = abby_mcp_call("get-billing-by-id", {"billingId": billing_id})
        ref = ""
        for obj in (info, fin):
            if isinstance(obj, dict):
                b = obj.get("billing") or obj
                if isinstance(b, dict) and b.get("number"):
                    ref = str(b["number"])
                    break
        if not ref:
            ref = dem["devis_ref"] or "Finalisé Abby"

        conn.execute(
            """UPDATE demandes
               SET devis_abby_id = ?, devis_abby_statut = 'finalise', devis_ref = ?, updated_at = ?
               WHERE id = ?""",
            (billing_id, ref, now_iso(), dem["id"]),
        )
    broadcast_event("demandes")
    return {"ok": True, "billing_id": billing_id, "ref": ref}


@app.post("/api/abby/devis/{billing_id}/send")
def send_abby_devis(billing_id: str, body: AbbyDevisSendBody, _auth: str = Depends(require_auth)):
    texte = (body.texte or "").strip()
    bad_phones = find_unauthorized_phones(texte)
    if bad_phones:
        raise HTTPException(status_code=400, detail=f"Numéro non autorisé dans le texte : {', '.join(bad_phones)}")

    with get_db() as conn:
        dem = conn.execute("SELECT * FROM demandes WHERE id = ?", (body.demande_id,)).fetchone()
        if not dem:
            raise HTTPException(status_code=404, detail="Demande introuvable.")
        ref = dem["devis_ref"] or billing_id

        if body.canal == "WhatsApp":
            tel = normalize_phone_digits(dem["telephone"] or "")
            if not tel:
                raise HTTPException(status_code=400, detail="Numéro WhatsApp client invalide ou absent.")
            pdf_bytes = _abby_download_pdf_bytes(billing_id)
            safe_ref = re.sub(r"[^A-Za-z0-9._-]+", "-", ref) or billing_id
            with tempfile.NamedTemporaryFile(prefix="devis-", suffix=".pdf", delete=False) as tf:
                tf.write(pdf_bytes)
                tmp_path = tf.name
            try:
                cmd = [
                    WACLI_BIN, "send", "file",
                    "--to", tel,
                    "--file", tmp_path,
                    "--filename", f"Devis-Pianissimo-{safe_ref}.pdf",
                    "--json",
                ]
                if texte:
                    cmd.extend(["--caption", texte])
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
                ok = False
                try:
                    ok = bool(json.loads(proc.stdout.strip().splitlines()[-1]).get("success"))
                except Exception:
                    ok = proc.returncode == 0
                if not ok:
                    err_msg = (proc.stderr or proc.stdout or "Échec wacli")[-200:]
                    raise HTTPException(status_code=502, detail=f"Envoi devis WhatsApp échoué : {err_msg}")
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        elif body.canal == "Email":
            dest = (dem["email"] or "").strip()
            if not dest:
                raise HTTPException(status_code=400, detail="Adresse email client absente.")
            subject = (body.objet or f"Devis Pianissimo {ref} — {dem['nom']}").strip()
            msg_text = texte or f"Bonjour,\n\nVeuillez trouver ci-joint notre devis {ref}.\n\nBien cordialement,\nMarie — PIANISSIMO\nContact Anthony : 06 28 23 07 61"
            pdf_bytes = _abby_download_pdf_bytes(billing_id)
            safe_ref = re.sub(r"[^A-Za-z0-9._-]+", "-", ref) or billing_id
            _send_gmail_with_pdf(dest, subject, msg_text, pdf_bytes, f"Devis-Pianissimo-{safe_ref}.pdf")
        else:
            raise HTTPException(status_code=400, detail="Canal d'envoi invalide (Email ou WhatsApp).")

        now = now_iso()
        conn.execute(
            """UPDATE demandes
               SET devis_abby_statut = 'envoye', devis_statut = 'envoye', updated_at = ?
               WHERE id = ?""",
            (now, dem["id"]),
        )
        conn.execute(
            """INSERT INTO messages_historique (id, demande_id, tournee_id, canal, direction, horodatage, contenu, auteur, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'sortant', ?, ?, 'Pianissimo (Devis Abby)', ?, ?)""",
            (str(uuid.uuid4()), dem["id"], dem["tournee_id"], body.canal, now, f"[Devis PDF {ref} envoyé]\n{texte}".strip(), now, now),
        )
    broadcast_event("demandes")
    broadcast_event("messages_historique")
    return {"ok": True, "ref": ref}


# ---------------------------------------------------------------------------
# Export planning -> Google Agenda Pianissimo
# ---------------------------------------------------------------------------

def _hhmm_to_paris_iso(day_iso: str, total_minutes: int) -> str:
    h = (total_minutes // 60) % 24
    m = total_minutes % 60
    dt = datetime.fromisoformat(f"{day_iso}T{h:02d}:{m:02d}:00")
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


@app.post("/api/tournees/{tournee_id}/sync-calendar")
def sync_tournee_calendar(tournee_id: str, body: CalendarSyncBody, _auth: str = Depends(require_auth)):
    with get_db() as conn:
        tour = conn.execute("SELECT * FROM tournees WHERE id = ?", (tournee_id,)).fetchone()
        if not tour:
            raise HTTPException(status_code=404, detail="Tournée introuvable.")
        dem_rows = conn.execute(
            """SELECT * FROM demandes
               WHERE tournee_id = ? AND jour_date IS NOT NULL AND jour_date != ''
                 AND statut NOT IN ('annule', 'doublon')
               ORDER BY jour_date ASC, ordre_jour ASC, heure_debut ASC""",
            (tournee_id,),
        ).fetchall()

    slot_map = {str(s.get("demande_id")): s for s in (body.slots or []) if s.get("demande_id")}
    planned_items: list[dict[str, Any]] = []
    for d in dem_rows:
        did = d["id"]
        custom = slot_map.get(did)
        if custom and custom.get("start_dt") and custom.get("end_dt"):
            start_dt = str(custom["start_dt"])
            end_dt = str(custom["end_dt"])
        else:
            hhmm = (d["heure_debut"] or "09:00")[:5]
            try:
                hh, mm = map(int, hhmm.split(":"))
            except Exception:
                hh, mm = 9, 0
            start_m = hh * 60 + mm
            dur_m = max(30, round(float(d["duree_estimee_h"] or 1.0) * 60))
            start_dt = _hhmm_to_paris_iso(d["jour_date"], start_m)
            end_dt = _hhmm_to_paris_iso(d["jour_date"], start_m + dur_m)

        desc_parts = [
            f"Tournée : {tour['nom']}",
            f"Statut : {d['statut']}",
            f"Instruments : {d['instruments_detail'] or 'à préciser'}",
            f"Téléphone : {d['telephone']}" if d["telephone"] else "",
            f"Email : {d['email']}" if d["email"] else "",
            f"Contraintes : {d['contraintes']}" if d["contraintes"] else "",
            f"Devis : {d['devis_ref']} ({d['devis_statut']})" if d["devis_ref"] else "",
        ]
        location = ", ".join(p for p in (d["adresse"], d["cp"], d["ville"], d["pays"]) if p)
        planned_items.append({
            "demande_id": did,
            "summary": f"Harpe — {d['nom']} ({d['ville'] or d['secteur']})",
            "location": location,
            "description": "\n".join(p for p in desc_parts if p),
            "start": {"dateTime": start_dt, "timeZone": "Europe/Paris"},
            "end": {"dateTime": end_dt, "timeZone": "Europe/Paris"},
            "extendedProperties": {
                "private": {
                    "pianissimo_tournee_id": tournee_id,
                    "pianissimo_demande_id": did,
                }
            },
        })

    prev_home = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = ANTHONY_HERMES_HOME
    try:
        script_dir = str(GOOGLE_API_SCRIPT.parent)
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)
        import google_api  # type: ignore

        service = google_api.build_service("calendar", "v3")
        existing_res = service.events().list(
            calendarId=PIANISSIMO_CALENDAR_ID,
            privateExtendedProperty=f"pianissimo_tournee_id={tournee_id}",
            singleEvents=False,
            maxResults=250,
        ).execute()
        existing_by_dem: dict[str, str] = {}
        for ev in existing_res.get("items", []):
            priv = (ev.get("extendedProperties") or {}).get("private") or {}
            if priv.get("pianissimo_demande_id"):
                existing_by_dem[str(priv["pianissimo_demande_id"])] = str(ev["id"])

        create_count = sum(1 for it in planned_items if it["demande_id"] not in existing_by_dem)
        update_count = sum(1 for it in planned_items if it["demande_id"] in existing_by_dem)

        if body.dry_run:
            return {
                "ok": True,
                "dry_run": True,
                "calendar_id": PIANISSIMO_CALENDAR_ID,
                "total": len(planned_items),
                "create_count": create_count,
                "update_count": update_count,
                "preview": [{"summary": it["summary"], "start": it["start"]["dateTime"]} for it in planned_items],
            }

        created = 0
        updated = 0
        for it in planned_items:
            ev_body = {k: v for k, v in it.items() if k != "demande_id"}
            eid = existing_by_dem.get(it["demande_id"])
            if eid:
                service.events().patch(calendarId=PIANISSIMO_CALENDAR_ID, eventId=eid, body=ev_body).execute()
                updated += 1
            else:
                service.events().insert(calendarId=PIANISSIMO_CALENDAR_ID, body=ev_body).execute()
                created += 1

        return {
            "ok": True,
            "dry_run": False,
            "calendar_id": PIANISSIMO_CALENDAR_ID,
            "created": created,
            "updated": updated,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Erreur Google Agenda : {exc}") from exc
    finally:
        if prev_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = prev_home


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
