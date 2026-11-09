"""Load the xView3 tile dataset and put every tile on the map.

The tiles only know their pixel position inside the original scene (meta/tiles.csv), while the
objects also carry lat/lon (meta/objects.csv). Per scene we fit a cubic polynomial
scene-pixel -> lat/lon on the objects (residuals < 10 m, i.e. below one pixel) and use it to
compute each tile's corner coordinates.
"""

from __future__ import annotations

import csv
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

TILE = 640
NO_VALUE_DIST = 9999.0  # dist_shore_km uses 9999.99 for "unknown"


def category(cls: str, source: str) -> str:
    """vessel with AIS -> 'ais', vessel without AIS -> 'dark', fixed object -> 'fixed'."""
    if cls == "non_vessel":
        return "fixed"
    return "dark" if source == "manual" else "ais"


def _design(rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    r, c = rows / 1e4, cols / 1e4
    return np.c_[r, c, r * r, r * c, c * c, r**3, r * r * c, r * c * c, c**3, np.ones(len(r))]


@dataclass
class GeoFit:
    lat_coef: np.ndarray
    lon_coef: np.ndarray
    max_err_m: float

    def __call__(self, rows, cols) -> tuple[np.ndarray, np.ndarray]:
        A = _design(np.asarray(rows, float), np.asarray(cols, float))
        return A @ self.lat_coef, A @ self.lon_coef


def _fit(points: np.ndarray) -> GeoFit:
    A = _design(points[:, 0], points[:, 1])
    lat, *_ = np.linalg.lstsq(A, points[:, 2], rcond=None)
    lon, *_ = np.linalg.lstsq(A, points[:, 3], rcond=None)
    err_lat = np.abs(A @ lat - points[:, 2]) * 111_320
    err_lon = np.abs(A @ lon - points[:, 3]) * 111_320 * np.cos(np.radians(points[:, 2]))
    return GeoFit(lat, lon, float(max(err_lat.max(), err_lon.max())))


def _num(v: str) -> float | None:
    return float(v) if v not in ("", None) else None


@dataclass
class Dataset:
    root: Path
    tiles: dict[str, dict] = field(default_factory=dict)
    objects: list[dict] = field(default_factory=list)
    scenes: dict[str, dict] = field(default_factory=dict)

    def image_path(self, tile_id: str) -> Path:
        t = self.tiles[tile_id]
        return self.root / "images" / t["split"] / f"{tile_id}.png"

    @classmethod
    def load(cls, root: Path) -> "Dataset":
        ds = cls(root=root)

        for r in csv.DictReader(open(root / "meta" / "tiles.csv")):
            ds.tiles[r["tile_id"]] = {
                "tile_id": r["tile_id"],
                "split": r["split"],
                "scene_id": r["scene_id"],
                "tile_row": int(r["tile_row"]),
                "tile_col": int(r["tile_col"]),
                "pixel_row": int(r["pixel_row"]),
                "pixel_col": int(r["pixel_col"]),
                "valid_fraction": float(r["valid_fraction"]),
                "counts": {"ais": 0, "dark": 0, "fixed": 0},
            }

        geo_points: dict[str, list] = defaultdict(list)
        for i, r in enumerate(csv.DictReader(open(root / "meta" / "objects.csv"))):
            t = ds.tiles[r["tile_id"]]
            dist = float(r["dist_shore_km"])
            fishing = {"True": True, "False": False}.get(r["is_fishing"])
            obj = {
                "id": i,
                "tile_id": r["tile_id"],
                "scene_id": r["scene_id"],
                "split": r["split"],
                "class": r["class"],
                "category": category(r["class"], r["source"]),
                "source": r["source"],
                "confidence": r["confidence"],
                "x_px": float(r["x_px"]),
                "y_px": float(r["y_px"]),
                "w_px": float(r["box_w_px"]),
                "h_px": float(r["box_h_px"]),
                "length_m": _num(r["length_m"]),
                "is_fishing": fishing,
                "dist_shore_km": None if dist >= NO_VALUE_DIST else dist,
                "lat": float(r["lat"]),
                "lon": float(r["lon"]),
            }
            ds.objects.append(obj)
            t["counts"][obj["category"]] += 1
            geo_points[r["scene_id"]].append(
                (t["pixel_row"] + obj["y_px"], t["pixel_col"] + obj["x_px"], obj["lat"], obj["lon"])
            )

        fits = {s: _fit(np.array(p)) for s, p in geo_points.items()}

        by_scene: dict[str, list[dict]] = defaultdict(list)
        for t in ds.tiles.values():
            by_scene[t["scene_id"]].append(t)
        for scene_id, tiles in by_scene.items():
            fit = fits[scene_id]
            rows = np.array([[t["pixel_row"], t["pixel_row"], t["pixel_row"] + TILE, t["pixel_row"] + TILE] for t in tiles])
            cols = np.array([[t["pixel_col"], t["pixel_col"] + TILE, t["pixel_col"] + TILE, t["pixel_col"]] for t in tiles])
            lat, lon = fit(rows.ravel(), cols.ravel())
            lat, lon = lat.reshape(-1, 4), lon.reshape(-1, 4)
            for t, la, lo in zip(tiles, lat, lon):
                t["corners"] = [[round(float(x), 6), round(float(y), 6)] for x, y in zip(lo, la)]
                t["center"] = [round(float(lo.mean()), 6), round(float(la.mean()), 6)]

            counts = Counter()
            for t in tiles:
                counts.update(t["counts"])
            all_lon = lon.ravel()
            all_lat = lat.ravel()
            ds.scenes[scene_id] = {
                "scene_id": scene_id,
                "split": tiles[0]["split"],
                "n_tiles": len(tiles),
                "n_empty_tiles": sum(1 for t in tiles if not any(t["counts"].values())),
                "counts": {k: counts.get(k, 0) for k in ("ais", "dark", "fixed")},
                "bbox": [float(all_lon.min()), float(all_lat.min()), float(all_lon.max()), float(all_lat.max())],
                "center": [float(all_lon.mean()), float(all_lat.mean())],
                "georef_max_err_m": round(fit.max_err_m, 1),
            }
        return ds

    def summary(self) -> dict:
        cats = Counter(o["category"] for o in self.objects)
        splits = Counter(t["split"] for t in self.tiles.values())
        return {
            "n_scenes": len(self.scenes),
            "n_tiles": len(self.tiles),
            "tiles_by_split": dict(splits),
            "n_objects": len(self.objects),
            "objects_by_category": {k: cats.get(k, 0) for k in ("ais", "dark", "fixed")},
        }
