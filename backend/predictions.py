"""Model detections per tile, cached on disk as data/cache/predictions/<run>.json.

The batch script (python -m backend.predict) fills the cache for whole splits. The API also predicts
a single tile on demand when it is opened in the viewer, and adds it to the same cache.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .dataset import Dataset
from .model import MIN_CONF, Detector, match


class PredictionStore:
    def __init__(self, ds: Dataset, detector: Detector, cache_dir: Path):
        self.ds = ds
        self.detector = detector
        self.path = cache_dir / f"{detector.name}.json"
        self._raw: dict[str, list[dict]] = {}
        self._enriched: dict[str, list[dict]] = {}
        self._lock = threading.Lock()
        # Weights change while a run is still training: then the cache is stale and starts over.
        self.weights_mtime = detector.weights.stat().st_mtime
        if self.path.exists():
            cached = json.loads(self.path.read_text())
            if cached.get("weights_mtime") == self.weights_mtime:
                self._raw = cached["tiles"]

    @property
    def tile_ids(self) -> list[str]:
        return [t for t in self._raw if t in self.ds.tiles]

    def predict(self, tile_ids: list[str], batch: int = 16, on_progress=None) -> None:
        """Run the model on tiles that are not cached yet, then save the cache."""
        todo = [t for t in tile_ids if t not in self._raw]
        for i in range(0, len(todo), batch):
            chunk = todo[i : i + batch]
            dets = self.detector.predict([self.ds.image_path(t) for t in chunk], batch=batch)
            with self._lock:
                self._raw.update(zip(chunk, dets))
            if on_progress:
                on_progress(min(i + batch, len(todo)), len(todo))
        if todo:
            self.save()

    def save(self) -> None:
        with self._lock:
            payload = {
                "model": self.detector.name,
                "weights_mtime": self.weights_mtime,
                "min_conf": MIN_CONF,
                "tiles": self._raw,
            }
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, separators=(",", ":")))
            tmp.replace(self.path)

    def for_tile(self, tile_id: str) -> list[dict]:
        """Detections for one tile, with id, lat/lon and the matched label (if any)."""
        if tile_id not in self._raw:
            self.predict([tile_id])
        if tile_id not in self._enriched:
            tile = self.ds.tiles[tile_id]
            dets = [{"id": f"{tile_id}:{i}", **d} for i, d in enumerate(self._raw[tile_id])]
            objects = [o for o in self.ds.objects if o["tile_id"] == tile_id]
            match(dets, objects)
            if dets:
                lat, lon = self.ds.tile_latlon(tile_id, [d["x_px"] for d in dets], [d["y_px"] for d in dets])
                for d, la, lo in zip(dets, lat, lon):
                    d.update(lat=round(float(la), 6), lon=round(float(lo), 6))
            for d in dets:
                d.update(tile_id=tile_id, scene_id=tile["scene_id"], split=tile["split"])
            self._enriched[tile_id] = dets
        return self._enriched[tile_id]

    def best_vessel_threshold(self, split: str = "val") -> dict | None:
        """Confidence threshold with the highest vessel F1 on one split, or None without predictions.

        A vessel detection is correct when it was matched to a labelled vessel (within 200 m). Because
        matching goes from high to low confidence, raising the threshold only drops detections, so one
        matching serves every threshold.
        """
        tile_ids = [t for t in self.tile_ids if self.ds.tiles[t]["split"] == split]
        if not tile_ids:
            return None
        vessel_ids = {o["id"] for o in self.ds.objects if o["class"] == "vessel" and o["split"] == split}
        dets = [d for t in tile_ids for d in self.for_tile(t) if d["class"] == "vessel"]
        best = None
        for conf in [round(0.05 * i, 2) for i in range(1, 19)]:
            kept = [d for d in dets if d["conf"] >= conf]
            tp = sum(1 for d in kept if d["match_id"] in vessel_ids)
            fp = len(kept) - tp
            fn = len(vessel_ids) - tp
            p = tp / (tp + fp) if tp + fp else 0.0
            r = tp / (tp + fn) if tp + fn else 0.0
            f1 = 2 * p * r / (p + r) if p + r else 0.0
            if best is None or f1 > best["f1"]:
                best = {"conf": conf, "f1": round(f1, 4), "precision": round(p, 4), "recall": round(r, 4)}
        return best

    def all(self) -> dict:
        tile_ids = self.tile_ids
        return {
            "model": self.detector.name,
            "min_conf": MIN_CONF,
            "tile_ids": tile_ids,
            "detections": [d for t in tile_ids for d in self.for_tile(t)],
        }
