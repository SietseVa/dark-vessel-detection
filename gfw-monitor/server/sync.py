"""Download Global Fishing Watch data for the North Sea into a local SQLite database.

    uv run python -m server.sync            # last 90 days
    uv run python -m server.sync --days 30

Stores:
  detections  Sentinel-1 radar detections per pass hour on GFW's 0.01 deg grid, matched to AIS or not,
              tagged with the EEZ they fall in.
  events      GFW fishing and loitering events (from AIS), with vessel identity.
  presence    AIS vessel presence per day on a 0.1 deg grid (traffic density).
The database is rebuilt in a temporary file and swapped in at the end, so the app keeps working
while a sync runs.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone

from .config import BBOX, DATA_DIR, DB_PATH, DEFAULT_DAYS, EEZ, EEZ_BY_ID
from .gfw import FISHING, GFW, LOITERING, PRESENCE, SAR, dumps, polygon

SCHEMA = """
CREATE TABLE detections (
  ts TEXT NOT NULL,          -- pass hour, UTC 'YYYY-MM-DD HH:00'
  lat REAL NOT NULL, lon REAL NOT NULL,
  matched INTEGER NOT NULL,  -- 1 = matched to AIS, 0 = no AIS (dark)
  n INTEGER NOT NULL,        -- detections in this cell and hour
  eez TEXT NOT NULL          -- ISO3 of the EEZ, or 'OTHER'
);
CREATE INDEX detections_ts ON detections(ts);
CREATE TABLE events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL,
  start TEXT NOT NULL, end TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  vessel_id TEXT, vessel_name TEXT, mmsi TEXT, flag TEXT, vessel_type TEXT,
  eez TEXT NOT NULL,
  duration_h REAL, distance_km REAL, avg_speed_kn REAL, dist_shore_km REAL
);
CREATE INDEX events_time ON events(start, end);
CREATE TABLE presence (
  day TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  hours REAL NOT NULL, vessels INTEGER NOT NULL
);
CREATE INDEX presence_day ON presence(day);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def chunks(start: date, end: date, days: int):
    d = start
    while d < end:
        e = min(end, d + timedelta(days=days))
        yield d.isoformat(), e.isoformat()
        d = e


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def in_bbox(lat: float, lon: float) -> bool:
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def sync_detections(api: GFW, start: date, end: date) -> list[tuple]:
    geo = polygon(BBOX)
    rows: dict[tuple, list] = {}
    for c0, c1 in chunks(start, end, 30):
        for matched in (0, 1):
            flt = [f"matched='{'true' if matched else 'false'}'"]
            got = api.report(SAR, c0, c1, geometry=geo, filters=flt)
            for r in got:
                key = (r["date"], round(float(r["lat"]), 4), round(float(r["lon"]), 4), matched)
                rows[key] = [int(r.get("detections") or 1), "OTHER"]
            log(f"  detections {c0}..{c1} {'matched' if matched else 'dark'}: {len(got)} cells")
    # Tag each cell with its EEZ by asking GFW for the same data per EEZ.
    for iso, (eez_id, name) in EEZ.items():
        tagged = 0
        for c0, c1 in chunks(start, end, 30):
            for matched in (0, 1):
                flt = [f"matched='{'true' if matched else 'false'}'"]
                for r in api.report(SAR, c0, c1, region=("public-eez-areas", eez_id), filters=flt):
                    key = (r["date"], round(float(r["lat"]), 4), round(float(r["lon"]), 4), matched)
                    if key in rows:
                        rows[key][1] = iso
                        tagged += 1
        log(f"  tagged {tagged} cells in {name} waters")
    return [(k[0], k[1], k[2], k[3], v[0], v[1]) for k, v in rows.items()]


def _eez_of(event: dict) -> str:
    for eid in (event.get("regions") or {}).get("eez") or []:
        if str(eid) in EEZ_BY_ID:
            return EEZ_BY_ID[str(eid)]
    return "OTHER"


def _hours(a: str, b: str) -> float | None:
    try:
        t0 = datetime.fromisoformat(a.replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(b.replace("Z", "+00:00"))
        return round((t1 - t0).total_seconds() / 3600, 2)
    except (AttributeError, ValueError):
        return None


def sync_events(api: GFW, start: date, end: date) -> list[tuple]:
    geo = polygon(BBOX)
    out = []
    for dataset, kind in ((FISHING, "fishing"), (LOITERING, "loitering")):
        n = 0
        for e in api.events(dataset, start.isoformat(), end.isoformat(), geo):
            pos = e.get("position") or {}
            if pos.get("lat") is None:
                continue
            v = e.get("vessel") or {}
            detail = e.get(kind) or {}
            dist = e.get("distances") or {}
            shore = detail.get("averageDistanceFromShoreKm", dist.get("startDistanceFromShoreKm"))
            out.append((
                e["id"], kind, e["start"], e["end"], float(pos["lat"]), float(pos["lon"]),
                v.get("id"), v.get("name"), v.get("ssvid"), v.get("flag"), v.get("type"),
                _eez_of(e), _hours(e["start"], e["end"]),
                detail.get("totalDistanceKm"), detail.get("averageSpeedKnots"), shore,
            ))
            n += 1
        log(f"  {kind} events: {n}")
    return out


def sync_presence(api: GFW, start: date, end: date) -> list[tuple]:
    geo = polygon(BBOX)
    out = []
    for c0, c1 in chunks(start, end, 7):
        got = api.report(PRESENCE, c0, c1, geometry=geo, resolution="LOW", temporal="DAILY")
        out += [(r["date"], float(r["lat"]), float(r["lon"]), float(r.get("hours") or 0), int(r.get("vesselIDs") or 0))
                for r in got if in_bbox(float(r["lat"]), float(r["lon"]))]
        log(f"  AIS presence {c0}..{c1}: {len(got)} cells")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS)
    args = ap.parse_args()

    end = datetime.now(timezone.utc).date() + timedelta(days=1)  # exclusive
    start = end - timedelta(days=args.days)
    api = GFW()
    t0 = time.time()
    log(f"Syncing North Sea {start} .. {end - timedelta(days=1)} ({args.days} days)")

    log("Radar detections")
    det = sync_detections(api, start, end)
    log("Events")
    ev = sync_events(api, start, end)
    log("AIS presence")
    pres = sync_presence(api, start, end)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DB_PATH.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    con.executemany("INSERT INTO detections VALUES (?,?,?,?,?,?)", det)
    con.executemany("INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ev)
    con.executemany("INSERT INTO presence VALUES (?,?,?,?,?)", pres)
    meta = {
        "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_start": start.isoformat(),
        "window_end": (end - timedelta(days=1)).isoformat(),
        "days": str(args.days),
        "bbox": dumps(BBOX),
        "detections_latest": max((d[0] for d in det), default=""),
        "presence_latest": max((p[0] for p in pres), default=""),
        "events_latest": max((e[3] for e in ev), default=""),
    }
    con.executemany("INSERT INTO meta VALUES (?,?)", list(meta.items()))
    con.commit()
    con.close()
    os.replace(tmp, DB_PATH)
    size = DB_PATH.stat().st_size / 1e6
    log(f"Done in {time.time() - t0:.0f}s: {len(det)} detection cells, {len(ev)} events, "
        f"{len(pres)} presence cells -> {DB_PATH} ({size:.0f} MB)")


if __name__ == "__main__":
    main()
