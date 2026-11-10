"""xView3-style F1 on the val split: a detection is correct within 200 m (20 px) of a label."""

import json
from collections import defaultdict

import numpy as np

from backend.config import DATA_DIR, PREDICTIONS_DIR
from backend.dataset import Dataset

ds = Dataset.load(DATA_DIR)
raw = json.loads((PREDICTIONS_DIR / "yolo26s-vessels-5.json").read_text())["tiles"]
val = [t for t, v in ds.tiles.items() if v["split"] == "val"]
assert all(t in raw for t in val)
objs = defaultdict(list)
for o in ds.objects:
    objs[o["tile_id"]].append(o)


def score(conf, pred_classes, label_cats):
    """Greedy matching, highest confidence first. Returns tp, fp, fn and recall per category."""
    tp = fp = 0
    found = defaultdict(int)
    total = defaultdict(int)
    for t in val:
        labels = [o for o in objs[t] if o["category"] in label_cats]
        for o in labels:
            total[o["category"]] += 1
        dets = sorted((d for d in raw[t] if d["conf"] >= conf and d["class"] in pred_classes), key=lambda d: -d["conf"])
        taken = set()
        for d in dets:
            best, bd = None, 20.0
            for o in labels:
                if o["id"] in taken:
                    continue
                dist = np.hypot(o["x_px"] - d["x_px"], o["y_px"] - d["y_px"])
                if dist <= bd:
                    best, bd = o, dist
            if best is None:
                fp += 1
            else:
                tp += 1
                taken.add(best["id"])
                found[best["category"]] += 1
    fn = sum(total.values()) - tp
    p = tp / (tp + fp) if tp + fp else 0
    r = tp / (tp + fn) if tp + fn else 0
    f1 = 2 * p * r / (p + r) if p + r else 0
    return dict(conf=conf, f1=f1, p=p, r=r, tp=tp, fp=fp, fn=fn,
                recall={c: (found[c], total[c]) for c in sorted(total)})


tasks = {
    "All objects (any class)": ({"vessel", "non_vessel"}, {"ais", "dark", "fixed"}),
    "Vessels": ({"vessel"}, {"ais", "dark"}),
    "Fixed objects": ({"non_vessel"}, {"fixed"}),
}
confs = np.round(np.arange(0.05, 0.91, 0.05), 2)
for name, (pc, lc) in tasks.items():
    results = [score(c, pc, lc) for c in confs]
    best = max(results, key=lambda r: r["f1"])
    at25 = next(r for r in results if r["conf"] == 0.25)
    for label, r in (("best", best), ("@0.25", at25)):
        rec = "  ".join(f"{c} {f}/{n} ({f / n:.0%})" for c, (f, n) in r["recall"].items())
        print(f"{name:24s} {label:5s} conf {r['conf']:.2f}  F1 {r['f1']:.3f}  P {r['p']:.3f}  R {r['r']:.3f}  "
              f"TP {r['tp']} FP {r['fp']} FN {r['fn']}  | {rec}")
