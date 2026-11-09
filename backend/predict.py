"""Run the YOLO model on every tile and cache the detections for the dashboard.

    uv run python -m backend.predict                  # all tiles, newest weights under runs/
    uv run python -m backend.predict --split val
    uv run python -m backend.predict --weights runs/detect/yolo26s-vessels-5/weights/best.pt

Already predicted tiles are skipped, unless the weights file changed since (e.g. a run that is
still training). The API picks up the cache on its next start.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import DATA_DIR, PREDICTIONS_DIR, RUNS_DIR
from .dataset import Dataset
from .model import Detector, find_weights
from .predictions import PredictionStore


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", type=Path, help="path to a .pt file (default: MODEL_PATH or newest under runs/)")
    p.add_argument("--split", choices=["all", "train", "val"], default="all")
    p.add_argument("--batch", type=int, default=16)
    args = p.parse_args()

    weights = args.weights or find_weights(RUNS_DIR)
    if weights is None or not weights.exists():
        sys.exit(f"No weights found (looked for {args.weights or RUNS_DIR / '**/weights/best.pt'}).")

    ds = Dataset.load(DATA_DIR)
    detector = Detector(weights)
    store = PredictionStore(ds, detector, PREDICTIONS_DIR)
    tile_ids = [t for t, v in ds.tiles.items() if args.split == "all" or v["split"] == args.split]
    print(f"Model {detector.name} ({weights}) on {detector.device}, imgsz {detector.imgsz}")
    print(f"{len(tile_ids)} tiles, {len(set(tile_ids) - set(store.tile_ids))} still to predict")

    def progress(done: int, total: int) -> None:
        print(f"\r  {done}/{total}", end="", flush=True)

    store.predict(tile_ids, batch=args.batch, on_progress=progress)
    print(f"\nSaved {store.path}")


if __name__ == "__main__":
    main()
