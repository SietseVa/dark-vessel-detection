"""Read recorded AIS, whichever source it came from, and place ships at a given moment."""

import json
import math
import sqlite3
from dataclasses import dataclass

import numpy as np

from .config import AIS_SOURCES

KNOT = 0.514444          # m/s
MAX_GAP_S = 600          # a fix older than this says nothing about where the ship is now
M_PER_DEG = 111_320.0


@dataclass
class Track:
    mmsi: int
    ts: np.ndarray       # sorted UTC epoch seconds
    lat: np.ndarray
    lon: np.ndarray
    sog: np.ndarray      # knots, nan = unknown
    cog: np.ndarray      # degrees, nan = unknown
    heading: np.ndarray  # degrees, nan = unknown


@dataclass
class Fix:
    """Where a ship was at the requested moment."""
    mmsi: int
    lat: float
    lon: float
    ve: float            # velocity east, m/s
    vn: float            # velocity north, m/s
    heading: float | None
    age_s: float         # distance in time to the nearest real AIS message
    method: str          # interpolated / extrapolated


def load_tracks(region: str, start_ts: float, end_ts: float, bbox) -> dict[int, Track]:
    """All tracks with a message inside bbox (lon_min, lat_min, lon_max, lat_max) in the time window."""
    db = sqlite3.connect(AIS_SOURCES[region])
    rows = db.execute(
        "SELECT mmsi, ts, lat, lon, sog, cog, heading FROM positions"
        " WHERE ts BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? ORDER BY mmsi, ts",
        (start_ts, end_ts, bbox[0], bbox[2], bbox[1], bbox[3]),
    ).fetchall()
    db.close()
    tracks = {}
    if not rows:
        return tracks
    data = np.array(rows, dtype=float)             # None becomes nan
    data[:, 6][data[:, 6] >= 360] = np.nan         # 511 = heading not available
    data[:, 5][data[:, 5] >= 360] = np.nan
    data[:, 4][data[:, 4] >= 102.3] = np.nan       # 102.3 kn = speed not available
    mmsis = data[:, 0].astype(np.int64)
    for start, stop in zip(*_runs(mmsis)):
        d = data[start:stop]
        tracks[int(mmsis[start])] = Track(int(mmsis[start]), d[:, 1], d[:, 2], d[:, 3], d[:, 4], d[:, 5], d[:, 6])
    return tracks


def _runs(values: np.ndarray):
    change = np.flatnonzero(np.diff(values)) + 1
    return np.concatenate([[0], change]), np.concatenate([change, [len(values)]])


def position_at(track: Track, t: float) -> Fix | None:
    """Interpolate between the messages around t, or carry the nearest one forward on its course."""
    i = int(np.searchsorted(track.ts, t))
    before = i - 1 if i > 0 else None
    after = i if i < len(track.ts) else None
    gap_before = t - track.ts[before] if before is not None else math.inf
    gap_after = track.ts[after] - t if after is not None else math.inf
    if min(gap_before, gap_after) > MAX_GAP_S:
        return None

    if gap_before <= MAX_GAP_S and gap_after <= MAX_GAP_S:
        span = track.ts[after] - track.ts[before]
        w = gap_before / span if span > 0 else 0.0
        lat = track.lat[before] + w * (track.lat[after] - track.lat[before])
        lon = track.lon[before] + w * (track.lon[after] - track.lon[before])
        coslat = math.cos(math.radians(lat))
        if span > 0:
            ve = (track.lon[after] - track.lon[before]) * M_PER_DEG * coslat / span
            vn = (track.lat[after] - track.lat[before]) * M_PER_DEG / span
        else:
            ve = vn = 0.0
        nearest = before if gap_before <= gap_after else after
        return Fix(track.mmsi, float(lat), float(lon), float(ve), float(vn),
                   _opt(track.heading[nearest]), float(min(gap_before, gap_after)), "interpolated")

    k = before if gap_before <= gap_after else after
    dt = t - track.ts[k]
    sog, cog = track.sog[k], track.cog[k]
    if np.isnan(sog) or np.isnan(cog):
        ve = vn = 0.0
    else:
        ve = sog * KNOT * math.sin(math.radians(cog))
        vn = sog * KNOT * math.cos(math.radians(cog))
    lat = track.lat[k] + vn * dt / M_PER_DEG
    lon = track.lon[k] + ve * dt / (M_PER_DEG * math.cos(math.radians(track.lat[k])))
    return Fix(track.mmsi, float(lat), float(lon), float(ve), float(vn),
               _opt(track.heading[k]), float(abs(dt)), "extrapolated")


def _opt(value: float) -> float | None:
    return None if np.isnan(value) else float(value)


def vessel_info(region: str, mmsis: list[int]) -> dict[int, dict]:
    """Name, type and size per ship, as far as its AIS messages told us."""
    db = sqlite3.connect(AIS_SOURCES[region])
    db.row_factory = sqlite3.Row
    info = {}
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "vessels" in tables:                       # Danish archive
        for chunk in _chunks(mmsis):
            marks = ",".join("?" * len(chunk))
            for r in db.execute(f"SELECT * FROM vessels WHERE mmsi IN ({marks})", chunk):
                info[r["mmsi"]] = dict(r)
    else:                                         # live recorder: raw static messages
        for chunk in _chunks(mmsis):
            marks = ",".join("?" * len(chunk))
            for r in db.execute(f"SELECT mmsi, name, raw FROM static WHERE mmsi IN ({marks}) ORDER BY ts", chunk):
                raw = json.loads(r["raw"])
                dim = raw.get("Dimension") or (raw.get("ReportB") or {}).get("Dimension") or {}
                entry = info.setdefault(r["mmsi"], {"mmsi": r["mmsi"], "name": None, "ship_type": None,
                                                    "length_m": None, "width_m": None, "callsign": None, "imo": None})
                entry["name"] = r["name"] or entry["name"]
                if dim.get("A", 0) + dim.get("B", 0) > 0:
                    entry["length_m"] = dim["A"] + dim["B"]
                    entry["width_m"] = dim.get("C", 0) + dim.get("D", 0)
                ship_type = raw.get("Type") or (raw.get("ReportB") or {}).get("ShipType")
                if ship_type:
                    entry["ship_type"] = str(ship_type)
                entry["callsign"] = (raw.get("CallSign") or "").strip() or entry["callsign"]
                if raw.get("ImoNumber"):
                    entry["imo"] = str(raw["ImoNumber"])
    db.close()
    return info


def _chunks(items: list, size: int = 500):
    for i in range(0, len(items), size):
        yield items[i:i + size]
