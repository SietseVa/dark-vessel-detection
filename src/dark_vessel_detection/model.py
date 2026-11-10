"""YOLO vessel detector: load trained weights, predict tiles, match detections to the labels.

Detections are always made at a low confidence (MIN_CONF) and matched greedily from high to low
confidence. Because of that order, filtering the result at any higher threshold gives exactly the
matching you would get by predicting at that threshold, so the dashboard can move its confidence
slider without asking the backend again.
"""

from __future__ import annotations

import csv
import os
import threading
from pathlib import Path

import numpy as np

MIN_CONF = 0.05
# xView3 counts a detection as correct within 200 m of the label: 20 px at 10 m per pixel.
MATCH_RADIUS_PX = 20.0
CLASSES = ("vessel", "non_vessel")


def run_name(weights: Path) -> str:
    """runs/detect/yolo26s-vessels-5/weights/best.pt -> 'yolo26s-vessels-5'."""
    return weights.parent.parent.name if weights.parent.name == "weights" else weights.stem


def _training_metrics(run_dir: Path) -> dict | None:
    """Val metrics of the best epoch (highest mAP50) in results.csv."""
    path = run_dir / "results.csv"
    if not path.exists():
        return None
    rows = [{k.strip(): v.strip() for k, v in r.items()} for r in csv.DictReader(open(path))]
    if not rows:
        return None
    best = max(rows, key=lambda r: float(r.get("metrics/mAP50(B)") or 0))
    return {
        "epochs_trained": len(rows),
        "best_epoch": int(float(best["epoch"])),
        "precision": float(best["metrics/precision(B)"]),
        "recall": float(best["metrics/recall(B)"]),
        "map50": float(best["metrics/mAP50(B)"]),
        "map50_95": float(best["metrics/mAP50-95(B)"]),
    }


class Detector:
    def __init__(self, weights: Path):
        self.weights = weights
        self.name = run_name(weights)
        self._model = None
        self._lock = threading.Lock()  # FastAPI runs sync endpoints in a thread pool

    @property
    def model(self):
        if self._model is None:
            from ultralytics import YOLO  # slow import, only when the model is first used

            self._model = YOLO(str(self.weights))
        return self._model

    @property
    def device(self) -> str:
        """MODEL_DEVICE if set (e.g. 'cpu' to keep the GPU free for training), else the fastest available."""
        if env := os.environ.get("MODEL_DEVICE"):
            return env
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        return "cuda" if torch.cuda.is_available() else "cpu"

    @property
    def imgsz(self) -> int:
        return int(self.model.overrides.get("imgsz") or 640)

    def info(self) -> dict:
        run_dir = self.weights.parent.parent
        return {
            "name": self.name,
            "weights": str(self.weights),
            "imgsz": self.imgsz,
            "classes": list(self.model.names.values()),
            "training": _training_metrics(run_dir),
        }

    def predict(self, images: list[Path], batch: int = 16) -> list[list[dict]]:
        """Raw detections per image, pixel coordinates in the 640x640 tile."""
        out: list[list[dict]] = []
        with self._lock:
            for i in range(0, len(images), batch):
                results = self.model.predict(
                    [str(p) for p in images[i : i + batch]],
                    imgsz=self.imgsz,
                    conf=MIN_CONF,
                    device=self.device,
                    verbose=False,
                )
                for r in results:
                    boxes = r.boxes
                    xywh = boxes.xywh.cpu().numpy()
                    conf = boxes.conf.cpu().numpy()
                    cls = boxes.cls.cpu().numpy().astype(int)
                    out.append([
                        {
                            "class": self.model.names[int(c)],
                            "conf": round(float(p), 4),
                            "x_px": round(float(x), 1),
                            "y_px": round(float(y), 1),
                            "w_px": round(float(w), 1),
                            "h_px": round(float(h), 1),
                        }
                        for (x, y, w, h), p, c in zip(xywh, conf, cls)
                    ])
        return out


def match(detections: list[dict], objects: list[dict]) -> None:
    """Greedy one-to-one matching on box centres, highest confidence first. Sets det['match_id']
    to the matched object's id or None. Class-agnostic: a vessel predicted as non_vessel still
    counts as found, and keeps its predicted class so the mix-up stays visible."""
    taken: set[int] = set()
    for d in sorted(detections, key=lambda d: -d["conf"]):
        d["match_id"] = None
        best, best_dist = None, MATCH_RADIUS_PX
        for o in objects:
            if o["id"] in taken:
                continue
            dist = float(np.hypot(o["x_px"] - d["x_px"], o["y_px"] - d["y_px"]))
            if dist <= best_dist:
                best, best_dist = o, dist
        if best is not None:
            d["match_id"] = best["id"]
            taken.add(best["id"])
