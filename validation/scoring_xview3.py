"""Precision, recall and F1 for the vessel detector, scored the xView3 way.

In xView3 a detection is correct when its centre lies within 200 m of a labelled object: 20 px at
10 m per pixel. Box overlap (IoU) is not used. The labels are tiny boxes, often only 8 px wide, so a
detection that is 1-2 px off already fails the IoU >= 0.5 rule Ultralytics uses, even though it found
the right object. That is why these scores are higher than the ones Ultralytics reports.

Run from the repo root:

    uv run python validation/scoring_xview3.py
    uv run python validation/scoring_xview3.py --weights runs/detect/<run>/weights/best.pt --split val
    uv run python validation/scoring_xview3.py --predictions data/cache/predictions/<run>.json

For each object group (all objects, vessels, fixed objects) it prints the scores at the confidence
threshold with the best F1, and at --conf (default 0.25), plus the share of AIS and dark vessels found.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
MATCH_RADIUS_PX = 20.0  # 200 m at 10 m per pixel, the xView3 rule


# ---- Data ------------------------------------------------------------------------------------


@dataclass
class Label:
    """A labelled object from meta/objects.csv. Position is the box centre in tile pixels."""

    id: int
    tile_id: str
    category: str  # 'ais' (vessel with AIS), 'dark' (vessel without AIS) or 'fixed'
    x_px: float
    y_px: float


@dataclass
class Detection:
    """A model detection. Position is the box centre in tile pixels."""

    tile_id: str
    cls: str  # 'vessel' or 'non_vessel'
    conf: float
    x_px: float
    y_px: float


def label_category(cls: str, source: str) -> str:
    """Classify a label: fixed object, vessel with AIS, or dark vessel.

    A vessel whose label source is 'manual' was found by an analyst without an AIS match, which
    makes it a dark vessel. Sources 'ais' and 'ais/manual' had AIS.
    """
    if cls == "non_vessel":
        return "fixed"
    return "dark" if source == "manual" else "ais"


def find_data_dir() -> Path:
    """The dataset folder: data/xview3_tiles/ if it exists, otherwise data/."""
    nested = REPO / "data" / "xview3_tiles"
    return nested if nested.exists() else REPO / "data"


def load_labels(data_dir: Path, split: str) -> dict[str, list[Label]]:
    """Read the labels of one split from meta/objects.csv, grouped per tile.

    Every tile of the split gets an entry, also tiles without objects, so that detections on empty
    sea are counted as false alarms.
    """
    labels: dict[str, list[Label]] = {}
    with open(data_dir / "meta" / "tiles.csv") as f:
        for row in csv.DictReader(f):
            if row["split"] == split:
                labels[row["tile_id"]] = []
    with open(data_dir / "meta" / "objects.csv") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if row["split"] == split:
                labels[row["tile_id"]].append(
                    Label(i, row["tile_id"], label_category(row["class"], row["source"]),
                          float(row["x_px"]), float(row["y_px"]))
                )
    return labels


def predict(weights: Path, data_dir: Path, split: str, tile_ids: list[str], min_conf: float = 0.05,
            batch: int = 16) -> dict[str, list[Detection]]:
    """Run the YOLO model on the tiles and return all detections above min_conf, grouped per tile.

    Predicting once at a low confidence is enough: higher thresholds are applied later by filtering.
    Uses the Apple GPU (mps) when available, then CUDA, then the CPU.
    """
    import torch
    from ultralytics import YOLO

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    model = YOLO(str(weights))
    imgsz = int(model.overrides.get("imgsz") or 640)
    out: dict[str, list[Detection]] = {}
    for i in range(0, len(tile_ids), batch):
        chunk = tile_ids[i : i + batch]
        paths = [str(data_dir / "images" / split / f"{t}.png") for t in chunk]
        for tile_id, r in zip(chunk, model.predict(paths, imgsz=imgsz, conf=min_conf, device=device, verbose=False)):
            xywh = r.boxes.xywh.cpu().numpy()
            out[tile_id] = [
                Detection(tile_id, model.names[int(c)], float(p), float(x), float(y))
                for (x, y, _, _), p, c in zip(xywh, r.boxes.conf.cpu().numpy(), r.boxes.cls.cpu().numpy())
            ]
        print(f"\r  predicted {min(i + batch, len(tile_ids))}/{len(tile_ids)} tiles", end="", flush=True)
    print()
    return out


def load_cached_predictions(path: Path) -> dict[str, list[Detection]]:
    """Read detections cached by the dashboard (python -m backend.predict on the dashboard branch)."""
    tiles = json.loads(path.read_text())["tiles"]
    return {
        t: [Detection(t, d["class"], d["conf"], d["x_px"], d["y_px"]) for d in dets]
        for t, dets in tiles.items()
    }


# ---- Matching --------------------------------------------------------------------------------


@dataclass
class MatchCounts:
    """Outcome of matching detections to labels.

    tp: true positives, detections on a labelled object.
    fp: false positives, detections with no labelled object within the radius.
    fn: false negatives, labelled objects no detection was matched to.
    found / total: per label category, how many labels were matched and how many there are.
    """

    tp: int = 0
    fp: int = 0
    fn: int = 0
    found: Counter = field(default_factory=Counter)
    total: Counter = field(default_factory=Counter)


def match_tile(detections: list[Detection], labels: list[Label], radius_px: float = MATCH_RADIUS_PX) -> MatchCounts:
    """Match the detections of one tile to its labels.

    Greedy one-to-one matching: detections are handled from highest to lowest confidence, and each
    takes the nearest label within radius_px that is still free. A detection that finds no free label
    is a false positive; a label that is never taken is a false negative.
    """
    counts = MatchCounts(total=Counter(l.category for l in labels))
    taken: set[int] = set()
    for det in sorted(detections, key=lambda d: -d.conf):
        best, best_dist = None, radius_px
        for label in labels:
            if label.id in taken:
                continue
            dist = float(np.hypot(label.x_px - det.x_px, label.y_px - det.y_px))
            if dist <= best_dist:
                best, best_dist = label, dist
        if best is None:
            counts.fp += 1
        else:
            counts.tp += 1
            counts.found[best.category] += 1
            taken.add(best.id)
    counts.fn = len(labels) - counts.tp
    return counts


def count_matches(predictions: dict[str, list[Detection]], labels: dict[str, list[Label]], conf: float,
                  pred_classes: set[str], label_categories: set[str]) -> MatchCounts:
    """Match over all tiles and add up the counts.

    Only detections with confidence >= conf and a class in pred_classes are used, and only labels with
    a category in label_categories. For example pred_classes={'vessel'}, label_categories={'ais',
    'dark'} scores vessels; a vessel the model calls 'non_vessel' then counts as missed.
    """
    total = MatchCounts()
    for tile_id, tile_labels in labels.items():
        dets = [d for d in predictions.get(tile_id, []) if d.conf >= conf and d.cls in pred_classes]
        tile = match_tile(dets, [l for l in tile_labels if l.category in label_categories])
        total.tp += tile.tp
        total.fp += tile.fp
        total.fn += tile.fn
        total.found += tile.found
        total.total += tile.total
    return total


# ---- Scores ----------------------------------------------------------------------------------


def precision(tp: int, fp: int) -> float:
    """Share of detections that are correct: TP / (TP + FP).

    Answers "when the model says there is something, how often is it right?". Every false alarm
    lowers it. Returns 0 when there are no detections.
    """
    return tp / (tp + fp) if tp + fp else 0.0


def recall(tp: int, fn: int) -> float:
    """Share of labelled objects that are found: TP / (TP + FN).

    Answers "of everything that is really there, how much does the model find?". Every missed object
    lowers it. Returns 0 when there are no labels.
    """
    return tp / (tp + fn) if tp + fn else 0.0


def f1_score(p: float, r: float) -> float:
    """Harmonic mean of precision and recall: 2·P·R / (P + R).

    One number that is only high when both precision and recall are high; a model cannot score well
    by flagging everything (high recall, low precision) or by flagging only sure cases (the reverse).
    Returns 0 when both are 0.
    """
    return 2 * p * r / (p + r) if p + r else 0.0


@dataclass
class Scores:
    """Precision, recall and F1 at one confidence threshold, with the counts they come from."""

    conf: float
    precision: float
    recall: float
    f1: float
    counts: MatchCounts


def evaluate(predictions: dict[str, list[Detection]], labels: dict[str, list[Label]], conf: float,
             pred_classes: set[str], label_categories: set[str]) -> Scores:
    """Precision, recall and F1 at one confidence threshold (see count_matches for the arguments)."""
    c = count_matches(predictions, labels, conf, pred_classes, label_categories)
    p, r = precision(c.tp, c.fp), recall(c.tp, c.fn)
    return Scores(conf, p, r, f1_score(p, r), c)


def best_threshold(predictions: dict[str, list[Detection]], labels: dict[str, list[Label]],
                   thresholds: list[float], pred_classes: set[str], label_categories: set[str]) -> list[Scores]:
    """Scores at every threshold; pick the best with max(..., key=lambda s: s.f1)."""
    return [evaluate(predictions, labels, t, pred_classes, label_categories) for t in thresholds]


# ---- Report ----------------------------------------------------------------------------------

# Name -> (predicted classes that count, label categories that count)
GROUPS = {
    "All objects (any class)": ({"vessel", "non_vessel"}, {"ais", "dark", "fixed"}),
    "Vessels": ({"vessel"}, {"ais", "dark"}),
    "Fixed objects": ({"non_vessel"}, {"fixed"}),
}


def format_scores(s: Scores) -> str:
    found = "  ".join(
        f"{cat} {s.counts.found[cat]}/{n} ({s.counts.found[cat] / n:.0%})" for cat, n in sorted(s.counts.total.items())
    )
    return (f"conf {s.conf:.2f}  P {s.precision:.3f}  R {s.recall:.3f}  F1 {s.f1:.3f}  "
            f"TP {s.counts.tp}  FP {s.counts.fp}  FN {s.counts.fn}  | found: {found}")


def newest_weights() -> Path | None:
    candidates = list((REPO / "runs").glob("**/weights/best.pt"))
    return max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--weights", type=Path, help="model .pt file (default: newest runs/**/weights/best.pt)")
    p.add_argument("--predictions", type=Path, help="use cached dashboard predictions instead of running the model")
    p.add_argument("--data", type=Path, default=None, help="dataset folder (default: data/xview3_tiles or data)")
    p.add_argument("--split", choices=["val", "train"], default="val")
    p.add_argument("--conf", type=float, default=0.25, help="fixed threshold to report next to the best one")
    args = p.parse_args()

    data_dir = args.data or find_data_dir()
    labels = load_labels(data_dir, args.split)
    if args.predictions:
        predictions = load_cached_predictions(args.predictions)
        missing = [t for t in labels if t not in predictions]
        if missing:
            raise SystemExit(f"{len(missing)} {args.split} tiles are missing from {args.predictions}")
        source = str(args.predictions)
    else:
        weights = args.weights or newest_weights()
        if weights is None:
            raise SystemExit("No weights found; pass --weights")
        predictions = predict(weights, data_dir, args.split, list(labels))
        source = str(weights)

    print(f"\n{source} on the {args.split} split ({len(labels)} tiles), match radius {MATCH_RADIUS_PX:.0f} px\n")
    thresholds = [round(float(t), 2) for t in np.arange(0.05, 0.91, 0.05)]
    for name, (pred_classes, label_categories) in GROUPS.items():
        print(name)
        sweep = best_threshold(predictions, labels, thresholds, pred_classes, label_categories)
        print(f"  best F1   {format_scores(max(sweep, key=lambda s: s.f1))}")
        print(f"  at {args.conf:.2f}   {format_scores(evaluate(predictions, labels, args.conf, pred_classes, label_categories))}")


if __name__ == "__main__":
    main()
