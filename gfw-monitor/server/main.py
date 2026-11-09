"""API for the North Sea dark vessel monitor. Serves the local GFW database built by server.sync.

    uv run uvicorn server.main:app --reload --port 8010
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date, timedelta

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware

from .config import DB_PATH, EEZ

app = FastAPI(title="North Sea Dark Vessel Monitor API")
app.add_middleware(GZipMiddleware, minimum_size=1000)

EVENT_COLUMNS = [
    "id", "type", "start", "end", "lat", "lon", "vessel_id", "vessel_name", "mmsi", "flag",
    "vessel_type", "eez", "duration_h", "distance_km", "avg_speed_kn", "dist_shore_km",
]


@contextmanager
def db():
    if not DB_PATH.exists():
        raise HTTPException(503, "No data yet. Run: uv run python -m server.sync")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        yield con
    finally:
        con.close()


def _day(s: str | None, field: str) -> date | None:
    if s is None:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(422, f"{field} must be YYYY-MM-DD")


@app.get("/api/meta")
def meta():
    with db() as con:
        m = dict(con.execute("SELECT key, value FROM meta").fetchall())
        counts = {
            "detections": con.execute("SELECT COALESCE(SUM(n),0) FROM detections").fetchone()[0],
            "dark": con.execute("SELECT COALESCE(SUM(n),0) FROM detections WHERE matched=0").fetchone()[0],
            "passes": con.execute("SELECT COUNT(DISTINCT ts) FROM detections").fetchone()[0],
            "fishing": con.execute("SELECT COUNT(*) FROM events WHERE type='fishing'").fetchone()[0],
            "loitering": con.execute("SELECT COUNT(*) FROM events WHERE type='loitering'").fetchone()[0],
        }
    waters = [{"code": k, "name": v[1]} for k, v in EEZ.items()] + [{"code": "OTHER", "name": "Other / high seas"}]
    return {**m, "counts": counts, "waters": waters}


@app.get("/api/detections")
def detections():
    """All radar detections in the window, compact: [ts, lat, lon, matched, n, eez]."""
    with db() as con:
        rows = con.execute("SELECT ts, lat, lon, matched, n, eez FROM detections ORDER BY ts").fetchall()
    return {"columns": ["ts", "lat", "lon", "matched", "n", "eez"], "rows": rows}


@app.get("/api/presence")
def presence(start: str = Query(...), end: str = Query(...)):
    """AIS presence summed over [start, end] (inclusive days) on the 0.1 deg grid: [lat, lon, hours]."""
    d0, d1 = _day(start, "start"), _day(end, "end")
    with db() as con:
        rows = con.execute(
            "SELECT lat, lon, ROUND(SUM(hours), 1) FROM presence WHERE day >= ? AND day <= ? GROUP BY lat, lon",
            (d0.isoformat(), d1.isoformat()),
        ).fetchall()
    return {"columns": ["lat", "lon", "hours"], "rows": rows}


@app.get("/api/events")
def events(
    start: str = Query(...),
    end: str = Query(...),
    type: str | None = Query(None, pattern="^(fishing|loitering)$"),
):
    """Events overlapping [start, end] (inclusive days)."""
    d0, d1 = _day(start, "start"), _day(end, "end")
    sql = f"SELECT {', '.join(EVENT_COLUMNS)} FROM events WHERE start < ? AND end >= ?"
    args: list = [(d1 + timedelta(days=1)).isoformat(), d0.isoformat()]
    if type:
        sql += " AND type = ?"
        args.append(type)
    with db() as con:
        rows = con.execute(sql, args).fetchall()
    return {"columns": EVENT_COLUMNS, "rows": rows}
