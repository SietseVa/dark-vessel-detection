"""Distance from a point to the nearest piece of offshore infrastructure."""

import json
import math
from functools import lru_cache

import numpy as np

from pipeline.infrastructure import OUT

MAX_M = 5000          # farther than this is not reported
M_PER_DEG = 111_320.0


@lru_cache(maxsize=2)
def _load(mtime: float):
    """Every line and polygon edge as a segment, every platform as a point."""
    features = json.loads(OUT.read_text())["features"]
    seg, seg_owner, pts, pts_owner, polygons = [], [], [], [], []
    for n, f in enumerate(features):
        g = f["geometry"]
        if g["type"] == "Point":
            pts.append(g["coordinates"])
            pts_owner.append(n)
            continue
        if g["type"] == "LineString":
            lines = [g["coordinates"]]
        elif g["type"] == "MultiLineString":
            lines = g["coordinates"]
        else:                                   # MultiPolygon: outer rings
            lines = [poly[0] for poly in g["coordinates"]]
            polygons += [(n, np.array(ring)) for ring in lines]
        for line in lines:
            a = np.array(line)
            if len(a) > 1:
                seg.append(np.hstack([a[:-1], a[1:]]))
                seg_owner += [n] * (len(a) - 1)
    return (features, np.vstack(seg), np.array(seg_owner), np.array(pts), np.array(pts_owner), polygons)


def _inside(ring: np.ndarray, lon: float, lat: float) -> bool:
    x1, y1, x2, y2 = ring[:-1, 0], ring[:-1, 1], ring[1:, 0], ring[1:, 1]
    crosses = (y1 > lat) != (y2 > lat)
    with np.errstate(divide="ignore", invalid="ignore"):
        at = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
    return bool(np.count_nonzero(crosses & (lon < at)) % 2)


def nearest(lon: float, lat: float) -> dict | None:
    """The closest wind farm, platform, pipeline or cable within MAX_M, or None."""
    if not OUT.exists():
        return None
    features, seg, seg_owner, pts, pts_owner, polygons = _load(OUT.stat().st_mtime)
    kx = M_PER_DEG * math.cos(math.radians(lat))
    reach_lon, reach_lat = MAX_M / kx, MAX_M / M_PER_DEG
    best, owner = MAX_M, None

    for n, ring in polygons:                    # inside a wind farm counts as distance 0
        if (ring[:, 0].min() <= lon <= ring[:, 0].max() and ring[:, 1].min() <= lat <= ring[:, 1].max()
                and _inside(ring, lon, lat)):
            best, owner = 0.0, n
            break

    if owner is None:
        near = ((np.minimum(seg[:, 0], seg[:, 2]) <= lon + reach_lon) & (np.maximum(seg[:, 0], seg[:, 2]) >= lon - reach_lon)
                & (np.minimum(seg[:, 1], seg[:, 3]) <= lat + reach_lat) & (np.maximum(seg[:, 1], seg[:, 3]) >= lat - reach_lat))
        if near.any():
            s = seg[near]
            ax, ay = (s[:, 0] - lon) * kx, (s[:, 1] - lat) * M_PER_DEG
            bx, by = (s[:, 2] - lon) * kx, (s[:, 3] - lat) * M_PER_DEG
            dx, dy = bx - ax, by - ay
            length2 = np.maximum(dx * dx + dy * dy, 1e-9)
            t = np.clip(-(ax * dx + ay * dy) / length2, 0, 1)
            d = np.hypot(ax + t * dx, ay + t * dy)
            i = int(d.argmin())
            if d[i] < best:
                best, owner = float(d[i]), int(seg_owner[near][i])
        if len(pts):
            d = np.hypot((pts[:, 0] - lon) * kx, (pts[:, 1] - lat) * M_PER_DEG)
            i = int(d.argmin())
            if d[i] < best:
                best, owner = float(d[i]), int(pts_owner[i])

    if owner is None:
        return None
    p = features[owner]["properties"]
    return {"kind": p["kind"], "name": p["name"], "detail": p["detail"], "distance_m": round(best)}
