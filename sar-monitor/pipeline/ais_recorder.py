"""Record live AIS for the Dutch part of the North Sea from aisstream.io into SQLite.

aisstream.io has no replay, so everything we want to match against a Sentinel-1 pass
has to be stored as it arrives. Run from the sar-monitor folder:

    uv run python -m pipeline.ais_recorder

Needs AISSTREAM_API_KEY in the repo's .env (or the environment).
"""

import asyncio
import json
import logging
import os
import signal
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import websockets

URL = "wss://stream.aisstream.io/v0/stream"
REPO = Path(__file__).resolve().parents[2]
DB_PATH = Path(os.environ.get("AIS_DB", REPO / "data" / "ais" / "ais.sqlite"))

# Dutch EEZ plus a margin: [[lat, lon], [lat, lon]]
BBOX = [[51.0, 2.0], [56.0, 7.5]]

POSITION_TYPES = {
    "PositionReport",                # class A
    "StandardClassBPositionReport",  # class B
    "ExtendedClassBPositionReport",  # class B, with name and dimensions
}
STATIC_TYPES = {"ShipStaticData", "StaticDataReport"}

COMMIT_EVERY_S = 2
STATUS_EVERY_S = 60
SILENCE_TIMEOUT_S = 90  # the box is busy; this long without a message means a dead connection

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    ts REAL NOT NULL,            -- UTC epoch seconds, as reported by aisstream
    mmsi INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sog REAL,                    -- knots
    cog REAL,                    -- degrees
    heading INTEGER,             -- degrees, 511 = not available
    nav_status INTEGER,
    msg_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_ts ON positions (ts);
CREATE INDEX IF NOT EXISTS positions_mmsi_ts ON positions (mmsi, ts);

CREATE TABLE IF NOT EXISTS static (
    ts REAL NOT NULL,
    mmsi INTEGER NOT NULL,
    msg_type TEXT NOT NULL,
    name TEXT,
    raw TEXT NOT NULL            -- the full message body as JSON
);
CREATE INDEX IF NOT EXISTS static_mmsi_ts ON static (mmsi, ts);

CREATE TABLE IF NOT EXISTS sessions (  -- when the recorder was actually connected
    started REAL NOT NULL,
    ended REAL,
    messages INTEGER NOT NULL DEFAULT 0
);
"""

log = logging.getLogger("ais")
_last_static: dict[tuple, str] = {}  # (mmsi, message type, part) -> last stored ship info


def load_key() -> str:
    key = os.environ.get("AISSTREAM_API_KEY")
    env = REPO / ".env"
    if not key and env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "AISSTREAM_API_KEY":
                key = value.strip().strip("'\"")
    if not key:
        raise SystemExit("AISSTREAM_API_KEY is missing: add it to .env")
    return key


def parse_time(text: str | None) -> float:
    """'2026-11-09 22:20:01.123456789 +0000 UTC' -> epoch seconds."""
    try:
        date, clock = text.split()[:2]
        whole, _, frac = clock.partition(".")
        dt = datetime.strptime(f"{date} {whole}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.timestamp() + (float(f"0.{frac}") if frac else 0.0)
    except Exception:
        return time.time()


def open_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(SCHEMA)
    return db


def store(db: sqlite3.Connection, msg: dict) -> bool:
    kind = msg.get("MessageType")
    meta = msg.get("MetaData") or {}
    body = (msg.get("Message") or {}).get(kind) or {}
    mmsi = meta.get("MMSI") or body.get("UserID")
    if not mmsi:
        return False
    ts = parse_time(meta.get("time_utc"))

    if kind in POSITION_TYPES:
        lat = body.get("Latitude", meta.get("latitude"))
        lon = body.get("Longitude", meta.get("longitude"))
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            return False
        db.execute(
            "INSERT INTO positions VALUES (?,?,?,?,?,?,?,?,?)",
            (ts, mmsi, lat, lon, body.get("Sog"), body.get("Cog"), body.get("TrueHeading"),
             body.get("NavigationalStatus"), kind),
        )
        if kind != "ExtendedClassBPositionReport":
            return True

    if kind in STATIC_TYPES or kind == "ExtendedClassBPositionReport":
        if kind == "ExtendedClassBPositionReport":  # keep only the part that is ship info
            body = {k: body.get(k) for k in ("Name", "Type", "Dimension")}
        # ships repeat the same info every few minutes: store it only when it changes
        raw = json.dumps(body, sort_keys=True)
        slot = (mmsi, kind, body.get("PartNumber"))
        if _last_static.get(slot) != raw:
            _last_static[slot] = raw
            name = (meta.get("ShipName") or "").strip() or None
            db.execute("INSERT INTO static VALUES (?,?,?,?,?)", (ts, mmsi, kind, name, raw))
        return True
    return False


async def record_once(db: sqlite3.Connection, key: str) -> None:
    subscription = {
        "APIKey": key,
        "BoundingBoxes": [BBOX],
        "FilterMessageTypes": sorted(POSITION_TYPES | STATIC_TYPES),
    }
    async with websockets.connect(URL, open_timeout=20, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps(subscription))
        session = db.execute("INSERT INTO sessions (started) VALUES (?)", (time.time(),)).lastrowid
        db.commit()
        log.info("connected, recording to %s", DB_PATH)
        count = since_status = 0
        last_commit = last_status = time.monotonic()
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=SILENCE_TIMEOUT_S)
                msg = json.loads(raw)
                if "error" in msg:
                    raise RuntimeError(f"aisstream: {msg['error']}")
                if store(db, msg):
                    count += 1
                    since_status += 1
                now = time.monotonic()
                if now - last_commit >= COMMIT_EVERY_S:
                    db.execute("UPDATE sessions SET ended=?, messages=? WHERE rowid=?",
                               (time.time(), count, session))
                    db.commit()
                    last_commit = now
                if now - last_status >= STATUS_EVERY_S:
                    log.info("%d messages in the last minute, %d this session", since_status, count)
                    since_status, last_status = 0, now
        finally:
            db.execute("UPDATE sessions SET ended=?, messages=? WHERE rowid=?",
                       (time.time(), count, session))
            db.commit()


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    key = load_key()
    db = open_db()
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, task.cancel)

    delay = 1
    try:
        while True:
            started = time.monotonic()
            try:
                await record_once(db, key)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("connection lost: %s: %s", type(exc).__name__, exc)
            # a connection that lasted a while resets the backoff
            delay = 1 if time.monotonic() - started > 60 else min(delay * 2, 60)
            log.info("reconnecting in %ds", delay)
            await asyncio.sleep(delay)
    except asyncio.CancelledError:
        log.info("stopped")
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
