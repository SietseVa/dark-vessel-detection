"""Import georeferenced PNG tiles, run YOLO, and overlay archived AIS at acquisition.

Run from sar-monitor: uv run python -m pipeline.yolo_tiles --help
"""

import argparse
from dataclasses import asdict
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import time

import numpy as np
from PIL import Image
from rasterio.warp import transform
from scipy.optimize import linear_sum_assignment

from .ais import load_tracks, position_at, vessel_info
from .config import DATA, AIS_SOURCES

OUT = DATA / "yolo-tiles"


def deduplicate(rows, threshold=0.45):
    """Scene-coordinate NMS; class agnostic because all classes describe vessels."""
    kept = []
    for row in sorted(rows, key=lambda d: -d["score"]):
        a = np.array(row["box"])
        duplicate = False
        for other in kept:
            b = np.array(other["box"])
            wh = np.maximum(0, np.minimum(a[2:], b[2:]) - np.maximum(a[:2], b[:2]))
            intersection = float(np.prod(wh))
            union = float(np.prod(a[2:] - a[:2]) + np.prod(b[2:] - b[:2]) - intersection)
            if union > 0 and intersection / union > threshold:
                duplicate = True
                break
        if not duplicate:
            kept.append(row)
    return kept


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--tiles", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--overlap", type=int, default=64)
    parser.add_argument("--region", choices=sorted(AIS_SOURCES), default="dk")
    parser.add_argument("--confidence", type=float, default=0.10)
    parser.add_argument("--match-m", type=float, default=300)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    from ultralytics import YOLO

    started = time.monotonic()
    meta = json.loads(args.scene.read_text())
    width, height = meta["size_px"]
    x0, y0 = meta["utm_upper_left"]
    pixel = meta["pixel_m"]
    files = sorted(args.tiles.glob("*.png"))
    if not files:
        raise ValueError("No PNG tiles found")
    size = Image.open(files[0]).width
    stride = size - args.overlap
    if not 0 <= args.overlap < size:
        raise ValueError("Invalid overlap")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "tiles").mkdir(exist_ok=True)
    tiles, arrays = [], {}
    for path in files:
        _, r, c = path.stem.rsplit("_", 2)
        r, c = int(r), int(c)
        image = np.array(Image.open(path).convert("RGB"))
        if image.shape != (size, size, 3):
            raise ValueError(f"Inconsistent tile size: {path.name}")
        if c * stride >= width or r * stride >= height:
            raise ValueError("Tile grid exceeds scene dimensions")
        arrays[r, c] = image
        tiles.append(dict(id=path.stem, row=r, col=c, x=c*stride, y=r*stride,
                          width=min(size, width-c*stride), height=min(size, height-r*stride)))
        shutil.copy2(path, OUT / "tiles" / path.name)
    # Verify geometry using the pixels themselves, rather than assuming filename spacing.
    checked = 0
    for (r, c), image in arrays.items():
        if args.overlap and (r, c+1) in arrays:
            if not np.array_equal(image[:, stride:], arrays[r, c+1][:, :args.overlap]):
                raise ValueError("Horizontal overlaps do not agree")
            checked += 1
        if args.overlap and (r+1, c) in arrays:
            if not np.array_equal(image[stride:], arrays[r+1, c][:args.overlap]):
                raise ValueError("Vertical overlaps do not agree")
            checked += 1
    mosaic = Image.new("RGB", (width, height))
    for t in tiles:
        mosaic.paste(Image.fromarray(arrays[t["row"], t["col"]]), (t["x"], t["y"]))
    mosaic.thumbnail((1600, 1600))
    mosaic.save(OUT / "overview.jpg", quality=90)
    del arrays

    model = YOLO(str(args.weights))
    raw = []
    for i, t in enumerate(tiles):
        result = model.predict(str(OUT / "tiles" / (t["id"] + ".png")),
                               imgsz=size, conf=args.confidence, device=args.device, verbose=False)[0]
        for box in result.boxes:
            b = box.xyxy[0].cpu().tolist()
            cx, cy = (b[0]+b[2])/2, (b[1]+b[3])/2
            if cx >= t["width"] or cy >= t["height"]:
                continue  # padded edge pixels
            cls = int(box.cls.item())
            raw.append(dict(tile_id=t["id"], box=[b[0]+t["x"], b[1]+t["y"], b[2]+t["x"], b[3]+t["y"]],
                            score=float(box.conf.item()), class_id=cls, label=model.names[cls]))
        print(f"Tile {i+1}/{len(tiles)}: {len(raw)} detections before deduplication", flush=True)
    detections = deduplicate(raw)
    for i, d in enumerate(detections):
        d.update(id=i+1, x=(d["box"][0]+d["box"][2])/2, y=(d["box"][1]+d["box"][3])/2,
                 mmsi=None, distance_m=None)
        lon, lat = transform(meta["crs"], "EPSG:4326", [x0+d["x"]*pixel], [y0-d["y"]*pixel])
        d.update(lon=lon[0], lat=lat[0])

    if not AIS_SOURCES[args.region].exists():
        raise ValueError(f"Missing AIS archive: {AIS_SOURCES[args.region]}")
    ts = datetime.fromisoformat(meta["acquired_utc"].replace("Z", "+00:00")).timestamp()
    lons, lats = transform(meta["crs"], "EPSG:4326", [x0, x0+width*pixel, x0, x0+width*pixel],
                           [y0, y0, y0-height*pixel, y0-height*pixel])
    bbox = (min(lons)-0.05, min(lats)-0.05, max(lons)+0.05, max(lats)+0.05)
    tracks = load_tracks(args.region, ts-600, ts+600, bbox)
    info = vessel_info(args.region, list(tracks))
    ships = []
    for track in tracks.values():
        fix = position_at(track, ts)
        if fix is None:
            continue
        east, north = transform("EPSG:4326", meta["crs"], [fix.lon], [fix.lat])
        x, y = (east[0]-x0)/pixel, (y0-north[0])/pixel
        if 0 <= x < width and 0 <= y < height:
            ships.append({**info.get(fix.mmsi, {}), **asdict(fix), "x": x, "y": y, "detection_id": None})
    # Independent geometric associations. Never inherit matches from the other detector.
    if detections and ships:
        a = np.array([[d["x"], d["y"]] for d in detections])
        b = np.array([[s["x"], s["y"]] for s in ships])
        distances = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=2) * pixel
        cost = np.where(distances <= args.match_m, distances, 1e9)
        for di, si in zip(*linear_sum_assignment(cost)):
            if distances[di, si] <= args.match_m:
                detections[di].update(mmsi=ships[si]["mmsi"], distance_m=float(distances[di, si]))
                ships[si]["detection_id"] = detections[di]["id"]
    payload = dict(scene=meta, tiles=tiles, tile_size=size, overlap=args.overlap,
                   verified_overlaps=checked, detections=detections, ships=ships,
                   model=dict(name=args.weights.parent.parent.name, weights=args.weights.name,
                              sha256=hashlib.sha256(args.weights.read_bytes()).hexdigest(), classes=model.names,
                              confidence=args.confidence, device=args.device),
                   matching=dict(radius_m=args.match_m, source=args.region, max_age_s=600,
                                 method="One-to-one proximity; no radar displacement correction"),
                   raw_detections=len(raw), elapsed_s=round(time.monotonic()-started, 1))
    tmp = OUT / "results.tmp"
    tmp.write_text(json.dumps(payload, allow_nan=False))
    tmp.replace(OUT / "results.json")
    print(f"Saved {len(detections)} detections and {len(ships)} AIS ships to {OUT}", flush=True)


if __name__ == "__main__":
    main()
