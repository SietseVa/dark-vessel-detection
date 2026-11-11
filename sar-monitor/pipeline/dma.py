"""Load historical AIS from the Danish Maritime Authority's open archive.

The archive (http://aisdata.ais.dk) has one zipped CSV per day with every AIS message
received by the Danish shore stations: exact time, position, speed and course, plus
ship name, type and dimensions. It covers Danish waters from 2006 on and runs about three days behind.

A day is about 3 GB unzipped, so we keep only the time around a satellite pass:

    uv run python -m pipeline.dma 2025-02-24 --around 17:02 --minutes 45

Timestamps in the files are UTC.
"""

import argparse
import csv
import io
import sqlite3
import time
import zipfile
from datetime import datetime, timedelta, timezone

import requests

from .config import DMA_DB, DMA_DIR

BUCKET = "http://aisdata.ais.dk.s3.eu-central-1.amazonaws.com"
VESSEL_TYPES = {"Class A", "Class B"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    ts REAL NOT NULL,            -- UTC epoch seconds
    mmsi INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    sog REAL,                    -- knots
    cog REAL,                    -- degrees
    heading INTEGER,             -- degrees, NULL = not available
    nav_status TEXT,
    msg_type TEXT NOT NULL       -- Class A / Class B
);
CREATE INDEX IF NOT EXISTS positions_ts ON positions (ts);
CREATE INDEX IF NOT EXISTS positions_mmsi_ts ON positions (mmsi, ts);

CREATE TABLE IF NOT EXISTS vessels (
    mmsi INTEGER PRIMARY KEY,
    name TEXT,
    ship_type TEXT,
    length_m REAL,
    width_m REAL,
    callsign TEXT,
    imo TEXT
);

CREATE TABLE IF NOT EXISTS loaded (   -- which time windows are in this database
    start_ts REAL NOT NULL,
    end_ts REAL NOT NULL,
    rows INTEGER NOT NULL
);
"""


def download(day: str):
    """Fetch aisdk-<day>.zip (about 0.6 GB) unless it is already on disk."""
    DMA_DIR.mkdir(parents=True, exist_ok=True)
    dest = DMA_DIR / f"aisdk-{day}.zip"
    if dest.exists():
        return dest
    print(f"downloading {dest.name}")
    tmp = dest.with_suffix(".part")
    # Days up to 26 February 2025 sit in a folder per year; newer days are at the top level.
    url = f"{BUCKET}/{day[:4]}/aisdk-{day}.zip"
    if requests.head(url, timeout=60).status_code != 200:
        url = f"{BUCKET}/aisdk-{day}.zip"
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 22):
                f.write(chunk)
    tmp.rename(dest)
    return dest


def _num(text: str):
    return float(text) if text else None


def _known(text: str):
    return text if text and text not in ("Unknown", "Undefined") else None


def load(day: str, start: datetime, end: datetime) -> int:
    """Copy the vessel messages between start and end (UTC) into the database."""
    path = download(day)
    db = sqlite3.connect(DMA_DB)
    db.executescript(SCHEMA)
    start_ts, end_ts = start.timestamp(), end.timestamp()
    if db.execute("SELECT 1 FROM loaded WHERE start_ts<=? AND end_ts>=?", (start_ts, end_ts)).fetchone():
        print("already loaded")
        return 0

    # Rows are in time order and the time is the first field, so whole hours can be
    # skipped on the text of the line before any parsing.
    lo, hi = start.strftime("%H:%M:%S"), end.strftime("%H:%M:%S")
    rows, vessels = [], {}
    began = time.time()
    with zipfile.ZipFile(path) as z, z.open(z.namelist()[0]) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
        next(text)  # header
        for line in text:
            clock = line[11:19]
            if clock < lo:
                continue
            if clock > hi:
                break
            f = next(csv.reader([line]))
            if f[1] not in VESSEL_TYPES or not f[3] or not f[4]:
                continue
            lat, lon = float(f[3]), float(f[4])
            if abs(lat) > 90 or abs(lon) > 180:   # 91 / 181 mean "no position"
                continue
            ts = datetime.strptime(f[0], "%d/%m/%Y %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
            mmsi = int(f[2])
            rows.append((ts, mmsi, lat, lon, _num(f[7]), _num(f[8]), int(float(f[9])) if f[9] else None,
                         _known(f[5]), f[1]))
            info = vessels.setdefault(mmsi, [None] * 6)
            for slot, value in enumerate((_known(f[12]), _known(f[13]), _num(f[16]), _num(f[15]),
                                          _known(f[11]), _known(f[10]))):
                if value is not None:
                    info[slot] = value

    db.execute("DELETE FROM positions WHERE ts BETWEEN ? AND ?", (start_ts, end_ts))
    db.executemany("INSERT INTO positions VALUES (?,?,?,?,?,?,?,?,?)", rows)
    db.executemany(
        "INSERT INTO vessels VALUES (?,?,?,?,?,?,?) ON CONFLICT(mmsi) DO UPDATE SET"
        " name=coalesce(excluded.name, name), ship_type=coalesce(excluded.ship_type, ship_type),"
        " length_m=coalesce(excluded.length_m, length_m), width_m=coalesce(excluded.width_m, width_m),"
        " callsign=coalesce(excluded.callsign, callsign), imo=coalesce(excluded.imo, imo)",
        [(mmsi, *info) for mmsi, info in vessels.items()],
    )
    db.execute("INSERT INTO loaded VALUES (?,?,?)", (start_ts, end_ts, len(rows)))
    db.commit()
    print(f"{len(rows)} positions of {len(vessels)} vessels between {start:%H:%M} and {end:%H:%M} UTC "
          f"({time.time() - began:.0f}s)")
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("day", help="date, e.g. 2025-02-24")
    ap.add_argument("--around", required=True, help="UTC time of the satellite pass, e.g. 17:02")
    ap.add_argument("--minutes", type=float, default=45, help="keep this many minutes before and after")
    args = ap.parse_args()
    centre = datetime.fromisoformat(f"{args.day}T{args.around}").replace(tzinfo=timezone.utc)
    day_start = centre.replace(hour=0, minute=0, second=0)
    start = max(centre - timedelta(minutes=args.minutes), day_start)
    end = min(centre + timedelta(minutes=args.minutes), day_start + timedelta(hours=23, minutes=59, seconds=59))
    load(args.day, start, end)


if __name__ == "__main__":
    main()
