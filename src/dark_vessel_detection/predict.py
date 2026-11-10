"""Run the YOLO model on every tile and cache the detections for the dashboard (`dvd predict`).

Already predicted tiles are skipped, unless the weights file changed since (e.g. a run that is
still training). The API picks up the cache on its next start.
"""

from __future__ import annotations

from pathlib import Path

from .config import Settings
from .dataset import Dataset
from .model import Detector
from .predictions import PredictionStore


def predict_dataset(settings: Settings, weights: Path, split: str = "all", batch: int = 16) -> Path:
    """Predict all tiles of a split ('all', 'train' or 'val') and return the cache file."""
    ds = Dataset.load(settings.data_dir)
    detector = Detector(weights)
    store = PredictionStore(ds, detector, settings.predictions_dir)
    tile_ids = [t for t, v in ds.tiles.items() if split == "all" or v["split"] == split]
    print(f"Model {detector.name} ({weights}) on {detector.device}, imgsz {detector.imgsz}")
    print(f"{len(tile_ids)} tiles, {len(set(tile_ids) - set(store.tile_ids))} still to predict")

    def progress(done: int, total: int) -> None:
        print(f"\r  {done}/{total}", end="", flush=True)

    store.predict(tile_ids, batch=batch, on_progress=progress)
    print(f"\nSaved {store.path}")
    return store.path
