"""Turn every YOLO run's results.csv into TensorBoard logs, optionally keeping them up to date.

    uv run --with tensorboard python scripts/runs_to_tensorboard.py --watch 30
    uv run --with tensorboard tensorboard --logdir runs/tensorboard

Works for runs that were started without TensorBoard logging, including runs still training.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import time
from pathlib import Path

from torch.utils.tensorboard import SummaryWriter

ROOT = Path(__file__).resolve().parent.parent


def convert(results: Path, logdir: Path) -> int:
    rows = [{k.strip(): v.strip() for k, v in r.items()} for r in csv.DictReader(open(results))]
    # Rewrite from scratch so a re-run never duplicates points.
    shutil.rmtree(logdir, ignore_errors=True)
    with SummaryWriter(str(logdir)) as w:
        for r in rows:
            step = int(float(r["epoch"]))
            for key, value in r.items():
                if key in ("epoch", "time") or not value:
                    continue
                # "metrics/mAP50(B)" -> "metrics/mAP50": TensorBoard groups charts by the prefix.
                w.add_scalar(key.replace("(B)", ""), float(value), step)
            if r.get("time"):
                w.add_scalar("time/elapsed_min", float(r["time"]) / 60, step)
    return len(rows)


def sync(runs: Path, out: Path, seen: dict[Path, float]) -> None:
    for results in sorted(runs.glob("**/results.csv")):
        if out in results.parents:
            continue
        mtime = results.stat().st_mtime
        if seen.get(results) == mtime:
            continue
        seen[results] = mtime
        name = "/".join(results.parent.relative_to(runs).parts)  # e.g. detect/yolo26s-vessels-5
        n = convert(results, out / name)
        print(f"{time.strftime('%H:%M:%S')}  {name}: {n} epochs", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--runs", type=Path, default=ROOT / "runs")
    p.add_argument("--out", type=Path, default=ROOT / "runs" / "tensorboard")
    p.add_argument("--watch", type=float, default=0, help="re-check every N seconds (0 = once)")
    args = p.parse_args()

    seen: dict[Path, float] = {}
    sync(args.runs, args.out, seen)
    while args.watch:
        time.sleep(args.watch)
        sync(args.runs, args.out, seen)


if __name__ == "__main__":
    main()
