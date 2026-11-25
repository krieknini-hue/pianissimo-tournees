#!/usr/bin/env python3
"""Synchronisation générique VPS (pianissimo.db / JSON audit) -> Supabase.

Aucune donnée personnelle ni secret dans ce script : tout est lu depuis les
variables d'environnement (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
TOURNEES_ACCESS_CODE, TOURNEE_JSON_PATH, PLANNING_JSON_PATH, PIANISSIMO_DB_PATH).
"""
import hashlib
import json
import os
import re
import sqlite3
import urllib.request
from pathlib import Path


def req_json(url, method="GET", payload=None, headers=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else None


def main():
    supabase_url = os.environ["SUPABASE_URL"].rstrip("/")
    pub_key = os.environ["SUPABASE_PUBLISHABLE_KEY"]
    code = os.environ["TOURNEES_ACCESS_CODE"]
    tournee_json = Path(os.environ["TOURNEE_JSON_PATH"])
    db_path = Path(os.environ.get("PIANISSIMO_DB_PATH", "/opt/data/pianissimo.db"))

    auth = req_json(
        f"{supabase_url}/functions/v1/tournees-auth",
        method="POST",
        payload={"code": code},
        headers={"Content-Type": "application/json", "apikey": pub_key},
    )
    token = auth["access_token"]
    headers = {
        "Content-Type": "application/json",
        "apikey": pub_key,
        "Authorization": f"Bearer {token}",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }

    src = json.loads(tournee_json.read_text(encoding="utf-8"))
    tournees = req_json(f"{supabase_url}/rest/v1/tournees?select=id,slug", headers=headers)
    slug = os.environ.get("TOURNEE_SLUG", "belgique-nord-paris-2026-12")
    tournee_id = next(t["id"] for t in tournees if t["slug"] == slug)
    demandes = req_json(
        f"{supabase_url}/rest/v1/demandes?tournee_id=eq.{tournee_id}&select=id,external_key,nom",
        headers=headers,
    )
    d_map = {d["external_key"]: d for d in demandes if d.get("external_key")}

    if not db_path.exists():
        print("SQLite DB introuvable, synchronisation terminée sans messages.")
        return

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows_to_upsert = []
    for r in src.get("rdvs", []):
        ext = r["id"]
        dem = d_map.get(ext)
        if not dem:
            continue
        nums = re.findall(r"\+?[0-9][0-9\s]{7,}", r.get("contact", ""))
        digits = [re.sub(r"\D", "", n)[-9:] for n in nums if len(re.sub(r"\D", "", n)) >= 8]
        for dg in digits:
            wa_rows = con.execute(
                "SELECT ts, from_me, text FROM whatsapp WHERE replace(replace(phone, '+', ''), ' ', '') LIKE ? AND ts >= '2026-10-01' ORDER BY ts DESC LIMIT 15",
                (f"%{dg}",),
            ).fetchall()
            for ts, from_me, txt in wa_rows:
                if not txt:
                    continue
                if len(ts) == 10:
                    ts = f"{ts}T09:00:00+01:00"
                elif " " in ts and "T" not in ts:
                    ts = ts.replace(" ", "T") + "+01:00"
                direction = "sortant" if from_me else "entrant"
                auteur = "Pianissimo" if from_me else dem["nom"]
                h = hashlib.sha256(f"{ext}|WA|{ts}|{direction}|{txt}".encode()).hexdigest()[:24]
                rows_to_upsert.append(
                    {
                        "demande_id": dem["id"],
                        "tournee_id": tournee_id,
                        "canal": "WhatsApp",
                        "direction": direction,
                        "horodatage": ts,
                        "contenu": txt,
                        "auteur": auteur,
                        "external_hash": h,
                    }
                )
    con.close()

    if rows_to_upsert:
        req_json(
            f"{supabase_url}/rest/v1/messages_historique?on_conflict=demande_id,external_hash",
            method="POST",
            payload=rows_to_upsert,
            headers=headers,
        )
    print(f"Synchronisation terminée : {len(rows_to_upsert)} message(s) vérifié(s).")


if __name__ == "__main__":
    main()
