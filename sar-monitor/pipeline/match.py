"""Compare the vessels detected in a scene with the ships that were broadcasting AIS.

    uv run python -m pipeline.match                 # every scene with detections
    uv run python -m pipeline.match <scene id> ...

For each scene:
1. Work out where every AIS ship was at the second the radar imaged it.
2. Move that position to where the ship should appear in the image: a ship moving
   towards or away from the radar shows up displaced along the satellite's track.
3. Pair detections and ships one-to-one, closest first overall, within a distance gate.

A detection without a ship is a dark candidate. A ship without a detection is "AIS only".
"""

import argparse
import json
import math

import numpy as np
import rasterio
from scipy.optimize import linear_sum_assignment

from . import ais
from . import db as monitor_db
from .config import REGIONS
from .scenes import scene_dir

WINDOW_S = 900            # AIS loaded this long before and after the scene
BASE_GATE_M = 300         # geolocation error plus the offset between GPS antenna and ship centre
GATE_GROWTH_M_PER_S = 1.5 # extra room per second since the nearest AIS message
MAX_GATE_M = 1000
ECHO_MIN_M = 150          # a second detection this close to a matched ship is the same ship
SHIFT_SIGN = -1.0         # a ship moving away from the satellite appears shifted against the flight
                          # direction; sign and size confirmed on real matches, see shift_check()

SAT_HEIGHT_M = 693_000
SAT_SPEED_M_S = 7_590
NEAR_INCIDENCE, FAR_INCIDENCE = 29.1, 46.0   # degrees, Sentinel-1 IW swath
# The images are georeferenced as if the sea lies on the reference ellipsoid. Around the
# North Sea the real sea surface is about 40 m higher, which makes everything afloat
# appear some 50 m closer to the satellite than it is.
SEA_HEIGHT_M = 40.0

M_PER_DEG = ais.M_PER_DEG


class Geometry:
    """Local east/north metres around the scene centre, and the radar's two directions."""

    def __init__(self, gcps):
        lon = np.array([g.x for g in gcps])
        lat = np.array([g.y for g in gcps])
        rows = np.array([g.row for g in gcps])
        cols = np.array([g.col for g in gcps])
        self.lon0, self.lat0 = lon.mean(), lat.mean()
        self.coslat = math.cos(math.radians(self.lat0))
        e, n = self.to_metres(lon, lat)
        # Least-squares plane: how (east, north) change per image row and per column.
        A = np.stack([np.ones_like(rows), rows, cols], axis=1)
        (_, e_row, e_col), *_ = np.linalg.lstsq(A, e, rcond=None)
        (_, n_row, n_col), *_ = np.linalg.lstsq(A, n, rcond=None)
        self.azimuth = np.array([e_row, n_row]) / math.hypot(e_row, n_row)   # along the flight direction
        self.range = np.array([e_col, n_col]) / math.hypot(e_col, n_col)     # away from the satellite
        # Position across the swath (0 = nearest to the satellite, 1 = farthest).
        B = np.stack([np.ones_like(e), e, n], axis=1)
        self.col_coef, *_ = np.linalg.lstsq(B, cols / cols.max(), rcond=None)

    def to_metres(self, lon, lat):
        return ((np.asarray(lon) - self.lon0) * M_PER_DEG * self.coslat,
                (np.asarray(lat) - self.lat0) * M_PER_DEG)

    def to_lonlat(self, e, n):
        return self.lon0 + e / (M_PER_DEG * self.coslat), self.lat0 + n / M_PER_DEG

    def incidence(self, e, n):
        frac = np.clip(self.col_coef[0] + self.col_coef[1] * e + self.col_coef[2] * n, 0, 1)
        return np.radians(NEAR_INCIDENCE + frac * (FAR_INCIDENCE - NEAR_INCIDENCE))

    def height_offset(self, e, n):
        """Metres towards the satellite that a ship appears displaced by the sea height."""
        return SEA_HEIGHT_M / np.tan(self.incidence(e, n))

    def shift_factor(self, e, n):
        """Seconds: azimuth shift in metres per m/s of speed away from the satellite."""
        incidence = self.incidence(e, n)
        slant_range = SAT_HEIGHT_M / np.cos(incidence - np.radians(3.5))
        return slant_range / SAT_SPEED_M_S * np.sin(incidence)


def inside(polygon: list, lon: float, lat: float) -> bool:
    hit = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def match_scene(db, scene_id: str, apply_shift: bool = True) -> dict:
    scene = db.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if scene is None:
        raise SystemExit(f"unknown scene {scene_id}")
    region = scene["region"]
    bbox = REGIONS[region]
    footprint = json.loads(scene["footprint"])["coordinates"][0]
    with rasterio.open(scene_dir(scene_id) / "vv.tiff") as src:
        geo = Geometry(src.gcps[0])

    detections = db.execute("SELECT id, ts, lat, lon FROM detections WHERE scene_id=? ORDER BY id",
                            (scene_id,)).fetchall()
    lons = [p[0] for p in footprint]
    lats = [p[1] for p in footprint]
    area = (max(min(lons), bbox[0]) - 0.05, max(min(lats), bbox[1]) - 0.05,
            min(max(lons), bbox[2]) + 0.05, min(max(lats), bbox[3]) + 0.05)
    tracks = ais.load_tracks(region, scene["start_ts"] - WINDOW_S, scene["end_ts"] + WINDOW_S, area)

    # Ships placed at the middle of the scene; the few seconds' difference per detection is added below.
    t_mid = (scene["start_ts"] + scene["end_ts"]) / 2
    fixes = []
    for track in tracks.values():
        fix = ais.position_at(track, t_mid)
        if (fix and inside(footprint, fix.lon, fix.lat)
                and bbox[0] <= fix.lon <= bbox[2] and bbox[1] <= fix.lat <= bbox[3]):
            fixes.append(fix)

    db.execute("DELETE FROM ais_at_pass WHERE scene_id=?", (scene_id,))
    db.execute("DELETE FROM echoes WHERE scene_id=?", (scene_id,))
    if not fixes:
        db.commit()
        return {"detections": len(detections), "ais": 0, "matched": 0, "echoes": 0}

    ship_e, ship_n = geo.to_metres([f.lon for f in fixes], [f.lat for f in fixes])
    vel = np.array([[f.ve, f.vn] for f in fixes])
    range_speed = vel @ geo.range                               # m/s away from the satellite
    shift = SHIFT_SIGN * geo.shift_factor(ship_e, ship_n) * range_speed if apply_shift else np.zeros(len(fixes))
    closer = geo.height_offset(ship_e, ship_n)
    sar_e = ship_e + shift * geo.azimuth[0] - closer * geo.range[0]
    sar_n = ship_n + shift * geo.azimuth[1] - closer * geo.range[1]
    gate = np.minimum(BASE_GATE_M + GATE_GROWTH_M_PER_S * np.array([f.age_s for f in fixes]), MAX_GATE_M)

    pairs = {}
    echoes = {}   # detection index -> ship index: a second detection on a ship that is already matched
    if detections:
        det_e, det_n = geo.to_metres([d["lon"] for d in detections], [d["lat"] for d in detections])
        dt = np.array([d["ts"] for d in detections]) - t_mid
        # distance[i, j]: detection i to ship j, with ship j moved to detection i's exact time
        de = det_e[:, None] - (sar_e[None, :] + dt[:, None] * vel[None, :, 0])
        dn = det_n[:, None] - (sar_n[None, :] + dt[:, None] * vel[None, :, 1])
        distance = np.hypot(de, dn)
        cost = np.where(distance <= gate[None, :], distance, 1e6)
        for i, j in zip(*linear_sum_assignment(cost)):
            if cost[i, j] < 1e6:
                pairs[j] = (i, float(distance[i, j]), float(de[i, j]), float(dn[i, j]))
        # A long ship can be detected twice. Any other detection lying on a matched ship's hull
        # belongs to that ship and must not count as a dark candidate.
        info_len = ais.vessel_info(region, [fixes[j].mmsi for j in pairs])
        taken = {i for i, *_ in pairs.values()}
        for j in pairs:
            reach = max(ECHO_MIN_M, 0.75 * (info_len.get(fixes[j].mmsi, {}).get("length_m") or 0))
            for i in np.flatnonzero(distance[:, j] <= reach):
                if int(i) not in taken:
                    echoes[int(i)] = j
                    taken.add(int(i))

    info = ais.vessel_info(region, [f.mmsi for f in fixes])
    sar_lon, sar_lat = geo.to_lonlat(sar_e, sar_n)
    for j, f in enumerate(fixes):
        v = info.get(f.mmsi, {})
        speed = math.hypot(f.ve, f.vn)
        course = math.degrees(math.atan2(f.ve, f.vn)) % 360 if speed > 0.1 else None
        hit = pairs.get(j)
        db.execute(
            "INSERT INTO ais_at_pass VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (scene_id, f.mmsi, f.lat, f.lon, float(sar_lat[j]), float(sar_lon[j]), speed / ais.KNOT, course,
             f.heading, f.age_s, f.method, v.get("name"), v.get("ship_type"), v.get("length_m"),
             v.get("width_m"), detections[hit[0]]["id"] if hit else None, hit[1] if hit else None),
        )
    for i, j in echoes.items():
        db.execute("INSERT INTO echoes VALUES (?,?,?)", (detections[i]["id"], scene_id, fixes[j].mmsi))
    db.commit()

    # Residuals of the matched pairs, split along the radar's two directions.
    residual = np.array([[de * geo.azimuth[0] + dn * geo.azimuth[1], de * geo.range[0] + dn * geo.range[1]]
                         for _, (_, _, de, dn) in sorted(pairs.items())]).reshape(-1, 2)
    idx = np.array(sorted(pairs), dtype=int)
    return {
        "detections": len(detections) - len(echoes), "ais": len(fixes), "matched": len(pairs),
        "echoes": len(echoes),
        "residual": residual, "range_speed": range_speed[idx], "factor": geo.shift_factor(ship_e, ship_n)[idx],
        "distance": np.array([pairs[j][1] for j in sorted(pairs)]),
    }


def shift_check(result: dict) -> str:
    """How well the predicted azimuth shift explains where moving ships were found."""
    moving = np.abs(result["range_speed"]) > 2
    if moving.sum() < 5:
        return "too few moving ships to check the azimuth shift"
    predicted = result["factor"][moving] * result["range_speed"][moving]
    left_over = result["residual"][moving, 0]
    slope = float(predicted @ left_over / (predicted @ predicted))
    return (f"azimuth shift check on {int(moving.sum())} moving ships: unexplained fraction {slope:+.2f} "
            f"(0 = prediction is right)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("scenes", nargs="*", help="scene ids; default: every scene with detections")
    ap.add_argument("--no-shift", action="store_true", help="do not correct for the shift of moving ships")
    args = ap.parse_args()
    db = monitor_db.connect()
    ids = args.scenes or [r["id"] for r in db.execute(
        "SELECT id FROM scenes WHERE status='detected' ORDER BY start_ts").fetchall()]
    for scene_id in ids:
        r = match_scene(db, scene_id, apply_shift=not args.no_shift)
        print(f"{scene_id}")
        print(f"  {r['detections']} detections ({r.get('echoes', 0)} second detections of a matched ship left out), "
              f"{r['ais']} AIS ships in the image, {r['matched']} matched")
        print(f"  dark candidates: {r['detections'] - r['matched']}, AIS only: {r['ais'] - r['matched']}")
        if r["matched"]:
            d = r["distance"]
            print(f"  match distance: median {np.median(d):.0f} m, 90% under {np.percentile(d, 90):.0f} m")
            az, rg = np.median(r["residual"], axis=0)
            print(f"  left-over offset: {az:+.0f} m along the track, {rg:+.0f} m away from the satellite")
            print(f"  {shift_check(r)}")


if __name__ == "__main__":
    main()
