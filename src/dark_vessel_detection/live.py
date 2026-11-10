"""Inference and AIS matching for newly tiled Sentinel-1 scenes."""

from __future__ import annotations

import csv
import json
import math
import re
import sqlite3
import threading
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from .model import Detector

LIVE_MIN_CONF = 0.15
AIS_MATCH_RADIUS_M = 200.0
VESSEL_CLASS = "vessel"
SCENE_ID = re.compile(
    r"(S1[A-Z]_IW_GRDH_1SDV_\d{8}T\d{6}_\d{8}T\d{6}_\d{6}_[A-Z0-9]+)"
)


@dataclass(frozen=True)
class Scene:
    key: str
    root: Path
    scene_id: str | None
    scene_ids: tuple[str, ...]
    area: str
    acquired_utc: str
    tile_count: int
    ais_count: int
    ais_covered: bool


def _utm_to_latlon(easting: float, northing: float, zone: int) -> tuple[float, float]:
    """Convert a northern-hemisphere WGS84 UTM coordinate to latitude and longitude."""
    a = 6_378_137.0
    eccentricity_sq = 0.00669437999014
    k0 = 0.9996
    e1 = (1 - math.sqrt(1 - eccentricity_sq)) / (1 + math.sqrt(1 - eccentricity_sq))
    x = easting - 500_000.0
    m = northing / k0
    mu = m / (a * (1 - eccentricity_sq / 4 - 3 * eccentricity_sq**2 / 64 - 5 * eccentricity_sq**3 / 256))
    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )
    e_prime_sq = eccentricity_sq / (1 - eccentricity_sq)
    sin_phi1 = math.sin(phi1)
    cos_phi1 = math.cos(phi1)
    tan_phi1 = math.tan(phi1)
    n1 = a / math.sqrt(1 - eccentricity_sq * sin_phi1**2)
    t1 = tan_phi1**2
    c1 = e_prime_sq * cos_phi1**2
    r1 = a * (1 - eccentricity_sq) / (1 - eccentricity_sq * sin_phi1**2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * tan_phi1 / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * e_prime_sq) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * e_prime_sq - 3 * c1**2) * d**6 / 720
    )
    lon = math.radians((zone - 1) * 6 - 180 + 3) + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * e_prime_sq + 24 * t1**2) * d**5 / 120
    ) / cos_phi1
    return math.degrees(lat), math.degrees(lon)


def _distance_m(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    radius = 6_371_000.0
    d_lat = math.radians(b_lat - a_lat)
    d_lon = math.radians(b_lon - a_lon)
    a = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(d_lon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


class LiveAnalysisStore:
    def __init__(
        self,
        sentinel_dir: Path,
        ais_db_path: Path,
        cache_dir: Path,
        detector: Detector | None,
    ):
        self.sentinel_dir = sentinel_dir
        self.ais_db_path = ais_db_path
        self.cache_dir = cache_dir
        self.detector = detector
        self._lock = threading.Lock()

    def _connect_ais(self) -> sqlite3.Connection:
        if not self.ais_db_path.is_file():
            raise FileNotFoundError(f"AIS database not found at {self.ais_db_path}")
        return sqlite3.connect(f"{self.ais_db_path.resolve().as_uri()}?mode=ro", uri=True)

    def _scene_from_metadata(self, root: Path, metadata: dict) -> Scene:
        area = metadata.get("area", root.parent.name)
        scene_ids = tuple(
            dict.fromkeys(
                match.group(1)
                for source in metadata.get("scenes", [])
                if (match := SCENE_ID.match(source.get("id", "")))
            )
        )
        scene_id = scene_ids[0] if scene_ids else None
        with (root / "tiles.csv").open() as f:
            tile_count = sum(1 for _ in csv.DictReader(f))
        ais_rows = self._ais_rows(scene_ids)
        with closing(self._connect_ais()) as db:
            placeholders = ",".join("?" for _ in scene_ids)
            status_rows = (
                db.execute(f"SELECT status FROM scenes WHERE id IN ({placeholders})", scene_ids).fetchall()
                if scene_ids
                else []
            )
        return Scene(
            key=f"{area}_{root.name}",
            root=root,
            scene_id=scene_id,
            scene_ids=scene_ids,
            area=area,
            acquired_utc=metadata.get("acquired_utc", ""),
            tile_count=tile_count,
            ais_count=len(ais_rows),
            ais_covered=bool(ais_rows) or any(row[0] == "detected" for row in status_rows),
        )

    def _scene(self, key: str) -> Scene:
        if not self.sentinel_dir.is_dir():
            raise FileNotFoundError(f"Sentinel-1 data directory not found at {self.sentinel_dir}")
        for metadata_path in self.sentinel_dir.rglob("scene.json"):
            root = metadata_path.parent
            if not (root / "tiles.csv").is_file():
                continue
            metadata = json.loads(metadata_path.read_text())
            area = metadata.get("area", root.parent.name)
            if f"{area}_{root.name}" != key:
                continue
            return self._scene_from_metadata(root, metadata)
        raise FileNotFoundError(f"Sentinel-1 scene {key!r} was not found under {self.sentinel_dir}")

    def scenes(self) -> list[dict]:
        if not self.sentinel_dir.is_dir():
            raise FileNotFoundError(f"Sentinel-1 data directory not found at {self.sentinel_dir}")
        out = []
        for metadata_path in sorted(self.sentinel_dir.rglob("scene.json")):
            root = metadata_path.parent
            if not (root / "tiles.csv").is_file():
                continue
            metadata = json.loads(metadata_path.read_text())
            scene = self._scene_from_metadata(root, metadata)
            out.append(
                {
                    "key": scene.key,
                    "scene_id": scene.scene_id,
                    "area": scene.area,
                    "acquired_utc": scene.acquired_utc,
                    "tile_count": scene.tile_count,
                    "ais_count": scene.ais_count,
                    "ais_covered": scene.ais_covered,
                }
            )
        return out

    def analyze_all(self) -> dict:
        """Run the detector once over every tile from every tiled Sentinel-1 scene."""
        if self.detector is None:
            raise RuntimeError("No model weights are available; set MODEL_PATH or add the configured model weights.")
        if not self.sentinel_dir.is_dir():
            raise FileNotFoundError(f"Sentinel-1 data directory not found at {self.sentinel_dir}")

        scenes = []
        for metadata_path in sorted(self.sentinel_dir.rglob("scene.json")):
            root = metadata_path.parent
            if (root / "tiles.csv").is_file():
                metadata = json.loads(metadata_path.read_text())
                scenes.append((self._scene_from_metadata(root, metadata), metadata))
        if not scenes:
            raise FileNotFoundError(f"No tiled Sentinel-1 scenes found under {self.sentinel_dir}")

        scene_inputs: list[tuple[Scene, dict, list[tuple[dict[str, str], Path]], list[dict], int]] = []
        all_paths: list[Path] = []
        for scene, metadata in scenes:
            with (scene.root / "tiles.csv").open() as f:
                tiles = list(csv.DictReader(f))
            if not tiles:
                raise ValueError(f"Scene {scene.key!r} contains no tiles")
            rows_by_path: list[tuple[dict[str, str], Path]] = []
            for tile in tiles:
                path = (scene.root / tile["file"]).resolve()
                if not path.is_relative_to(scene.root.resolve()) or not path.is_file():
                    raise FileNotFoundError(
                        f"Tile image is missing or outside scene {scene.key!r}: {tile['file']}"
                    )
                rows_by_path.append((tile, path))
            tile_size = int(json.loads((scene.root / "tiles.json").read_text()).get("tile_size", 640))
            ais_rows = self._ais_rows(scene.scene_ids)
            scene_inputs.append((scene, metadata, rows_by_path, ais_rows, tile_size))
            all_paths.extend(path for _, path in rows_by_path)

        with self._lock:
            predictions = self.detector.predict(all_paths, batch=16)
            if len(predictions) != len(all_paths):
                raise RuntimeError("The model returned a different number of tile results than it received.")

            results = []
            offset = 0
            for scene, metadata, rows_by_path, ais_rows, tile_size in scene_inputs:
                end = offset + len(rows_by_path)
                analysis = self._build_analysis(
                    scene, metadata, rows_by_path, predictions[offset:end], ais_rows, tile_size
                )

                input_mtime = max(
                    [path.stat().st_mtime for _, path in rows_by_path]
                    + [
                        (scene.root / "tiles.csv").stat().st_mtime,
                        (scene.root / "scene.json").stat().st_mtime,
                    ]
                )
                cache_path = self.cache_dir / "live" / f"{scene.key}-{self.detector.name}.json"
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = cache_path.with_suffix(".tmp")
                tmp.write_text(
                    json.dumps(
                        {
                            "input_mtime": input_mtime,
                            "weights_mtime": self.detector.weights.stat().st_mtime,
                            "ais_mtime": self.ais_db_path.stat().st_mtime,
                            "ais_scene_ids": list(scene.scene_ids),
                            "analysis": analysis,
                        },
                        separators=(",", ":"),
                    )
                )
                tmp.replace(cache_path)
                results.append(analysis)
                offset = end

        return {
            "scene_count": len(results),
            "tile_count": len(all_paths),
            "scenes": results,
        }

    def tile_image(self, scene_key: str, tile_id: str) -> Path:
        scene = self._scene(scene_key)
        with (scene.root / "tiles.csv").open() as f:
            for tile in csv.DictReader(f):
                if tile["tile_id"] != tile_id:
                    continue
                image_path = (scene.root / tile["file"]).resolve()
                if not image_path.is_relative_to(scene.root.resolve()) or not image_path.is_file():
                    break
                return image_path
        raise FileNotFoundError(f"Tile {tile_id!r} was not found in scene {scene_key!r}")

    def tiles(self, scene_key: str) -> list[dict]:
        scene = self._scene(scene_key)
        metadata = json.loads((scene.root / "scene.json").read_text())
        tile_size = int(json.loads((scene.root / "tiles.json").read_text()).get("tile_size", 640))
        width, height = metadata["size_px"]
        utm_x0, utm_y0 = metadata["utm_upper_left"]
        pixel_m = float(metadata["pixel_m"])
        tiles = []
        with (scene.root / "tiles.csv").open() as f:
            for tile in csv.DictReader(f):
                row = int(tile["pixel_row"])
                col = int(tile["pixel_col"])
                tile_width = min(tile_size, width - col)
                tile_height = min(tile_size, height - row)
                zone = int(tile["utm_zone"])
                pixel_corners = [
                    (col, row),
                    (col + tile_width, row),
                    (col + tile_width, row + tile_height),
                    (col, row + tile_height),
                ]
                corners = []
                for x, y in pixel_corners:
                    lat, lon = _utm_to_latlon(
                        float(utm_x0) + x * pixel_m,
                        float(utm_y0) - y * pixel_m,
                        zone,
                    )
                    corners.append([round(lon, 6), round(lat, 6)])
                center_lat, center_lon = _utm_to_latlon(
                    float(utm_x0) + (col + tile_width / 2) * pixel_m,
                    float(utm_y0) - (row + tile_height / 2) * pixel_m,
                    zone,
                )
                tiles.append(
                    {
                        "scene_key": scene.key,
                        "tile_id": tile["tile_id"],
                        "tile_row": int(tile.get("tile_row", 0)),
                        "tile_col": int(tile.get("tile_col", 0)),
                        "corners": corners,
                        "center": [round(center_lon, 6), round(center_lat, 6)],
                    }
                )
        return tiles

    def analyze(self, scene_key: str) -> dict:
        if self.detector is None:
            raise RuntimeError("No model weights are available; set MODEL_PATH or add the configured model weights.")
        scene = self._scene(scene_key)
        with (scene.root / "tiles.csv").open() as f:
            tiles = list(csv.DictReader(f))
        if not tiles:
            raise ValueError(f"Scene {scene_key!r} contains no tiles")

        tile_size = int(json.loads((scene.root / "tiles.json").read_text()).get("tile_size", 640))
        metadata = json.loads((scene.root / "scene.json").read_text())
        width, height = metadata["size_px"]
        rows_by_path: list[tuple[dict[str, str], Path]] = []
        for tile in tiles:
            path = (scene.root / tile["file"]).resolve()
            if not path.is_relative_to(scene.root.resolve()) or not path.is_file():
                raise FileNotFoundError(f"Tile image is missing or outside its scene folder: {tile['file']}")
            rows_by_path.append((tile, path))

        cache_path = self.cache_dir / "live" / f"{scene.key}-{self.detector.name}.json"
        input_mtime = max(
            [p.stat().st_mtime for _, p in rows_by_path]
            + [(scene.root / "tiles.csv").stat().st_mtime, (scene.root / "scene.json").stat().st_mtime]
        )
        weights_mtime = self.detector.weights.stat().st_mtime
        ais_mtime = self.ais_db_path.stat().st_mtime
        ais_rows = self._ais_rows(scene.scene_ids)
        with self._lock:
            if cache_path.is_file():
                cached = json.loads(cache_path.read_text())
                if (
                    cached.get("input_mtime") == input_mtime
                    and cached.get("weights_mtime") == weights_mtime
                    and cached.get("ais_mtime") == ais_mtime
                    and cached.get("ais_scene_ids") == list(scene.scene_ids)
                ):
                    return cached["analysis"]

            predictions = self.detector.predict([path for _, path in rows_by_path], batch=16)
            if len(predictions) != len(rows_by_path):
                raise RuntimeError("The model returned a different number of tile results than it received.")
            analysis = self._build_analysis(scene, metadata, rows_by_path, predictions, ais_rows, tile_size)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "input_mtime": input_mtime,
                        "weights_mtime": weights_mtime,
                        "ais_mtime": ais_mtime,
                        "ais_scene_ids": list(scene.scene_ids),
                        "analysis": analysis,
                    },
                    separators=(",", ":"),
                )
            )
            tmp.replace(cache_path)
            return analysis

    def _ais_rows(self, scene_ids: tuple[str, ...]) -> list[dict]:
        if not scene_ids:
            return []
        placeholders = ",".join("?" for _ in scene_ids)
        with closing(self._connect_ais()) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                f"""SELECT scene_id, mmsi, lat, lon, sar_lat, sar_lon, sog_kn, cog_deg, heading_deg,
                           age_s, method, name, ship_type, length_m, width_m
                    FROM ais_at_pass WHERE scene_id IN ({placeholders})""",
                scene_ids,
            ).fetchall()
        by_mmsi: dict[int, dict] = {}
        for row in rows:
            item = dict(row)
            previous = by_mmsi.get(item["mmsi"])
            if previous is None or item["age_s"] < previous["age_s"]:
                by_mmsi[item["mmsi"]] = item
        return list(by_mmsi.values())

    def _build_analysis(
        self,
        scene: Scene,
        metadata: dict,
        rows_by_path: list[tuple[dict[str, str], Path]],
        predictions: list[list[dict]],
        ais_rows: list[dict],
        tile_size: int,
    ) -> dict:
        width, height = metadata["size_px"]
        utm_x0, utm_y0 = metadata["utm_upper_left"]
        pixel_m = float(metadata["pixel_m"])
        detections = []
        for (tile, _), tile_predictions in zip(rows_by_path, predictions):
            tile_row = int(tile["pixel_row"])
            tile_col = int(tile["pixel_col"])
            zone = int(tile["utm_zone"])
            for index, prediction in enumerate(tile_predictions):
                if prediction["class"] != VESSEL_CLASS or prediction["conf"] < LIVE_MIN_CONF:
                    continue
                x_px = float(prediction["x_px"])
                y_px = float(prediction["y_px"])
                global_col = tile_col + x_px + 0.5
                global_row = tile_row + y_px + 0.5
                if global_col >= width or global_row >= height:
                    continue
                if not self._owns_pixel(tiles=rows_by_path, tile=tile, x_px=x_px, y_px=y_px, width=width, height=height, tile_size=tile_size):
                    continue
                lat, lon = _utm_to_latlon(
                    float(utm_x0) + global_col * pixel_m,
                    float(utm_y0) - global_row * pixel_m,
                    zone,
                )
                detections.append(
                    {
                        "id": f"{tile['tile_id']}:{index}",
                        "scene_key": scene.key,
                        "tile_id": tile["tile_id"],
                        "conf": prediction["conf"],
                        "x_px": x_px,
                        "y_px": y_px,
                        "w_px": prediction["w_px"],
                        "h_px": prediction["h_px"],
                        "lat": round(lat, 6),
                        "lon": round(lon, 6),
                        "ais_status": "unknown" if not scene.ais_covered else "potential_dark",
                        "ais_distance_m": None,
                        "ais": None,
                    }
                )

        if scene.ais_covered:
            self._match_ais(detections, ais_rows)
        return {
            "scene_id": scene.scene_id,
            "scene_key": scene.key,
            "area": scene.area,
            "acquired_utc": scene.acquired_utc,
            "model": self.detector.name if self.detector else None,
            "min_conf": LIVE_MIN_CONF,
            "match_radius_m": AIS_MATCH_RADIUS_M,
            "ais_covered": scene.ais_covered,
            "ais_count": len(ais_rows),
            "detections": detections,
        }

    @staticmethod
    def _owns_pixel(
        tiles: list[tuple[dict[str, str], Path]],
        tile: dict[str, str],
        x_px: float,
        y_px: float,
        width: int,
        height: int,
        tile_size: int,
    ) -> bool:
        col = int(tile["pixel_col"])
        row = int(tile["pixel_row"])
        cols = sorted({int(item["pixel_col"]) for item, _ in tiles})
        rows = sorted({int(item["pixel_row"]) for item, _ in tiles})
        col_index = cols.index(col)
        row_index = rows.index(row)
        left = 0.0 if col_index == 0 else (cols[col_index - 1] + tile_size + col) / 2 - col
        right = (
            min(tile_size, width - col)
            if col_index == len(cols) - 1
            else (col + tile_size + cols[col_index + 1]) / 2 - col
        )
        top = 0.0 if row_index == 0 else (rows[row_index - 1] + tile_size + row) / 2 - row
        bottom = (
            min(tile_size, height - row)
            if row_index == len(rows) - 1
            else (row + tile_size + rows[row_index + 1]) / 2 - row
        )
        return left <= x_px < right and top <= y_px < bottom

    @staticmethod
    def _match_ais(detections: list[dict], ais_rows: list[dict]) -> None:
        pairs = []
        for detection_index, detection in enumerate(detections):
            for ais_index, ais in enumerate(ais_rows):
                distance = _distance_m(detection["lat"], detection["lon"], ais["sar_lat"], ais["sar_lon"])
                if distance <= AIS_MATCH_RADIUS_M:
                    pairs.append((distance, detection_index, ais_index))
        used_detections: set[int] = set()
        used_ais: set[int] = set()
        for distance, detection_index, ais_index in sorted(pairs):
            if detection_index in used_detections or ais_index in used_ais:
                continue
            detection = detections[detection_index]
            detection["ais_status"] = "matched"
            detection["ais_distance_m"] = round(distance, 1)
            detection["ais"] = ais_rows[ais_index]
            used_detections.add(detection_index)
            used_ais.add(ais_index)
