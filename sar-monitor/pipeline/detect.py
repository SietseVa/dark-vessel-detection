"""Detect vessels in downloaded Sentinel-1 scenes and store them in the monitor database.

    uv run python -m pipeline.detect                 # every downloaded scene not yet processed
    uv run python -m pipeline.detect <scene id> ...  # specific scenes (again)

Steps per scene, following Ai2's published inference pipeline:
1. Warp the raw VV and VH images to web mercator at ~9.55 m per pixel, only where the
   scene overlaps our area of interest, and clip the values to 0..255. Two earlier
   images of the same place are warped onto the same grid, so the detector can tell
   ships from things that are always there.
2. Slide a 2048 x 2048 window over the image and run the detector on each window.
3. Drop duplicate detections that are within 10 pixels of a stronger one.
4. Run the attribute model on a crop around each detection (length, heading, speed, ...).
"""

import argparse
import json
import math
import os
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np
import rasterio
import torch
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject, transform as warp_points

from . import db as monitor_db
from . import model
from .config import REGIONS
from .scenes import fetch_history, scene_dir

WEB_MERCATOR_M = 2 * math.pi * 6378137
PIXEL_M = WEB_MERCATOR_M / 512 / 2**13   # 9.55 m: the resolution the model was trained on

WINDOW = 2048
PADDING = 400        # detections this close to a window edge are left to the neighbouring window
OVERLAP = 20
CONF = 0.3           # keep weak detections too; the app filters on confidence (default 90%)
HISTORY = 2          # earlier images of the same place given to the detector
NMS_PX = 10
ATTR_CROP = 120
SAVED_CROP = 128
QUICKLOOK_STEP = 8     # the map picture keeps every 8th pixel (about 45 m on the ground)


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def warp_scene(folder, bbox, history=()) -> tuple[np.ndarray, Affine, callable] | None:
    """Returns (image as uint8, pixel -> web mercator transform, lon/lat -> raw row).

    The image has channels [vh, vv] of the scene, followed by [vh, vv] of each earlier
    date in `history` (a list of lists of folders), all on the same pixel grid.
    bbox is the region to keep (lon_min, lat_min, lon_max, lat_max).
    None when the scene does not overlap it.
    """
    with rasterio.open(folder / "vv.tiff") as src:
        gcps, gcp_crs = src.gcps
        raw_height = src.height

    # Output grid: the part of the scene inside the region.
    gx, gy = warp_points(gcp_crs, "EPSG:3857", [g.x for g in gcps], [g.y for g in gcps])
    ax, ay = warp_points("EPSG:4326", "EPSG:3857", [bbox[0], bbox[2]], [bbox[1], bbox[3]])
    left, right = max(min(gx), ax[0]), min(max(gx), ax[1])
    bottom, top = max(min(gy), ay[0]), min(max(gy), ay[1])
    if right - left < PIXEL_M * 256 or top - bottom < PIXEL_M * 256:
        return None
    width = int((right - left) / PIXEL_M)
    height = int((top - bottom) / PIXEL_M)
    dst_transform = Affine(PIXEL_M, 0, left, 0, -PIXEL_M, top)

    def warp(path) -> np.ndarray:
        with rasterio.open(path) as src:
            out = np.zeros((height, width), dtype=np.uint16)
            reproject(
                source=rasterio.band(src, 1),
                destination=out,
                gcps=src.gcps[0],
                src_crs=src.gcps[1],
                dst_transform=dst_transform,
                dst_crs="EPSG:3857",
                resampling=Resampling.bilinear,
                num_threads=os.cpu_count() or 4,
                SRC_METHOD="GCP_TPS",   # thin-plate spline through the control points
            )
            return np.minimum(out, 255).astype(np.uint8)

    # The full image can be 10+ GB with history, so it lives in a file on disk, not in memory.
    groups = [[folder]] + [list(g) for g in history]
    image = np.lib.format.open_memmap(folder / "warped.npy", mode="w+", dtype=np.uint8,
                                      shape=(2 * len(groups), height, width))
    for n, group in enumerate(groups):
        for k, pol in enumerate(("vh", "vv")):
            for source in group:                      # several slices of one date are laid together
                np.maximum(image[2 * n + k], warp(source / f"{pol}.tiff"), out=image[2 * n + k])

    # Raw image row (= time within the scene) as a smooth function of lon/lat.
    lon = np.array([g.x for g in gcps])
    lat = np.array([g.y for g in gcps])
    rows = np.array([g.row for g in gcps])
    lon0, lat0 = lon.mean(), lat.mean()

    def design(lo, la):
        lo, la = np.asarray(lo) - lon0, np.asarray(la) - lat0
        return np.stack([np.ones_like(lo), lo, la, lo * la, lo * lo, la * la], axis=-1)

    coef, *_ = np.linalg.lstsq(design(lon, lat), rows, rcond=None)

    def row_fraction(lo, la):
        return np.clip(design(lo, la) @ coef / raw_height, 0, 1)

    return image, dst_transform, row_fraction


def save_quicklook(image: np.ndarray, transform: Affine, folder) -> None:
    """A small greyscale picture of the scene for the map, with its corner coordinates."""
    vv = image[1, ::QUICKLOOK_STEP, ::QUICKLOOK_STEP].astype(np.float32)
    grey = np.clip(vv / 160, 0, 1) ** 0.6 * 255          # brighten the dark sea a little
    rgba = np.zeros((*vv.shape, 4), dtype=np.uint8)
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = grey.astype(np.uint8)
    rgba[..., 3] = np.where(vv > 0, 255, 0)              # outside the radar swath is transparent
    Image.fromarray(rgba).save(folder / "quicklook.png")
    height, width = image.shape[1:]
    xs, ys = transform * (np.array([0, width]), np.array([0, height]))
    lons, lats = warp_points("EPSG:3857", "EPSG:4326", list(xs), list(ys))
    (folder / "quicklook.json").write_text(json.dumps(
        {"west": lons[0], "north": lats[0], "east": lons[1], "south": lats[1]}))


def save_map_image(image: np.ndarray, transform: Affine, folder) -> None:
    """The full-resolution VV image as a tiled GeoTIFF with overviews; the API cuts map tiles from it."""
    height, width = image.shape[1:]
    path = folder / "map.tif"
    with rasterio.open(path, "w", driver="GTiff", height=height, width=width, count=1, dtype="uint8",
                       crs="EPSG:3857", transform=transform, tiled=True, blockxsize=512, blockysize=512,
                       compress="deflate", BIGTIFF="IF_SAFER") as dst:
        for r0 in range(0, height, 4096):
            block = np.ascontiguousarray(image[1, r0:r0 + 4096])
            dst.write(block, 1, window=((r0, r0 + block.shape[0]), (0, width)))
        dst.build_overviews([2, 4, 8, 16, 32, 64], Resampling.average)


def window_offsets(size: int) -> list[int]:
    if size <= WINDOW:
        return [0]
    step = WINDOW - 2 * PADDING
    return [0] + list(range(step, size - WINDOW, step)) + [size - WINDOW]


def run_detector(detector, image: np.ndarray, device) -> np.ndarray:
    """Returns an array of (row, col, score) in image pixels."""
    _, height, width = image.shape
    if height < WINDOW or width < WINDOW:   # pad small images up to one window
        padded = np.zeros((image.shape[0], max(height, WINDOW), max(width, WINDOW)), dtype=np.uint8)
        padded[:, :height, :width] = image
        image = padded
    _, full_h, full_w = image.shape
    found = []
    rows, cols = window_offsets(full_h), window_offsets(full_w)
    started = time.time()
    with torch.no_grad():
        for n, r0 in enumerate(rows):
            for c0 in cols:
                crop = np.ascontiguousarray(image[:, r0:r0 + WINDOW, c0:c0 + WINDOW])
                if not crop[:2].any():      # outside the radar swath
                    continue
                out = detector([torch.from_numpy(crop).to(device).float() / 255])[0]
                boxes = out["boxes"].cpu().numpy()
                scores = out["scores"].cpu().numpy()
                labels = out["labels"].cpu().numpy()

                lo_c = (0 if c0 == 0 else PADDING) - OVERLAP
                lo_r = (0 if r0 == 0 else PADDING) - OVERLAP
                hi_c = (WINDOW if c0 >= full_w - WINDOW else WINDOW - PADDING) + OVERLAP
                hi_r = (WINDOW if r0 >= full_h - WINDOW else WINDOW - PADDING) + OVERLAP
                for box, score, label in zip(boxes, scores, labels):
                    if score < CONF or label != model.VESSEL_LABEL:
                        continue
                    cc, cr = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                    if lo_c <= cc <= hi_c and lo_r <= cr <= hi_r:
                        row, col = r0 + int(cr), c0 + int(cc)
                        if row < height and col < width:
                            found.append((row, col, float(score)))
            print(f"  window row {n + 1}/{len(rows)}, {len(found)} detections, {time.time() - started:.0f}s",
                  flush=True)
    return np.array(found, dtype=np.float64).reshape(-1, 3)


def suppress_duplicates(found: np.ndarray) -> np.ndarray:
    """Keep the strongest detection of any group within NMS_PX pixels."""
    order = np.argsort(-found[:, 2], kind="stable")
    grid: dict[tuple[int, int], list[int]] = {}
    keep = []
    for i in order:
        r, c = found[i, 0], found[i, 1]
        cell = (int(r // NMS_PX), int(c // NMS_PX))
        near = (j for dr in (-1, 0, 1) for dc in (-1, 0, 1)
                for j in grid.get((cell[0] + dr, cell[1] + dc), ()))
        if any(math.hypot(found[j, 0] - r, found[j, 1] - c) <= NMS_PX for j in near):
            continue
        grid.setdefault(cell, []).append(i)
        keep.append(i)
    return found[sorted(keep)]


def crop_at(image: np.ndarray, row: int, col: int, size: int) -> np.ndarray:
    half = size // 2
    row = int(np.clip(row, half, image.shape[1] - half))
    col = int(np.clip(col, half, image.shape[2] - half))
    return image[:, row - half:row + half, col - half:col + half]


def run_attributes(attr, image: np.ndarray, found: np.ndarray, device) -> np.ndarray:
    """Returns per detection: length_m, width_m, heading_deg, heading_conf, speed_kn, fishing_score."""
    result = np.zeros((len(found), 6))
    with torch.no_grad():
        for start in range(0, len(found), 32):
            batch = found[start:start + 32]
            crops = np.stack([crop_at(image, int(r), int(c), ATTR_CROP)[:2] for r, c, _ in batch])
            out = attr(torch.from_numpy(crops).to(device).float() / 255).cpu()
            heading = torch.softmax(out[:, 2:18], dim=1)
            conf, bucket = heading.max(dim=1)
            result[start:start + len(batch)] = torch.stack([
                100 * out[:, 0],
                100 * out[:, 1],
                (bucket.float() + 0.5) * 22.5,     # centre of the 22.5 degree bucket
                conf,
                out[:, 18],
                torch.softmax(out[:, 19:21], dim=1)[:, 1],
            ], dim=1).numpy()
    return result


def process(db, scene_id: str, device, models) -> int:
    scene = db.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if scene is None:
        raise SystemExit(f"unknown scene {scene_id}")
    folder = scene_dir(scene_id)
    started = time.time()

    history = fetch_history(scene, HISTORY) if HISTORY else []
    print(f"{scene_id}: warping, with {len(history)} earlier images")
    warped = warp_scene(folder, REGIONS[scene["region"]], history)
    db.execute("DELETE FROM detections WHERE scene_id=?", (scene_id,))
    if warped is None:
        print("  no overlap with the area of interest")
        found = np.zeros((0, 3))
    else:
        image, transform, row_fraction = warped
        print(f"  image {image.shape[2]} x {image.shape[1]} px, {time.time() - started:.0f}s")
        save_quicklook(image, transform, folder)
        save_map_image(image, transform, folder)
        detector, attr = models
        found = suppress_duplicates(run_detector(detector, image, device))
        attrs = run_attributes(attr, image, found, device)

        xs, ys = transform * (found[:, 1] + 0.5, found[:, 0] + 0.5)
        lons, lats = warp_points("EPSG:3857", "EPSG:4326", list(xs), list(ys))
        fractions = row_fraction(lons, lats) if len(found) else []
        crops = folder / "crops"
        crops.mkdir(exist_ok=True)
        for old in crops.glob("*.png"):
            old.unlink()
        for n, ((row, col, score), a) in enumerate(zip(found, attrs)):
            ts = scene["start_ts"] + float(fractions[n]) * (scene["end_ts"] - scene["start_ts"])
            db.execute(
                "INSERT INTO detections VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"{scene_id}_{n}", scene_id, ts, lats[n], lons[n], score, *map(float, a), int(row), int(col)),
            )
            crop = crop_at(image, int(row), int(col), SAVED_CROP)
            Image.fromarray(crop[1]).save(crops / f"{n}_vv.png")
            Image.fromarray(crop[0]).save(crops / f"{n}_vh.png")
            if crop.shape[0] > 2:      # the same spot on the previous image, to see what is always there
                Image.fromarray(crop[3]).save(crops / f"{n}_before.png")
        del image, warped
        (folder / "warped.npy").unlink(missing_ok=True)

    elapsed = time.time() - started
    db.execute("UPDATE scenes SET status='detected', detected_at=?, detect_seconds=?, error=NULL WHERE id=?",
               (time.time(), elapsed, scene_id))
    db.commit()
    print(f"  {len(found)} vessels detected in {elapsed:.0f}s")
    return len(found)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("scenes", nargs="*", help="scene ids; default: all downloaded, unprocessed scenes")
    ap.add_argument("--map-only", action="store_true", help="only (re)make the images shown on the map")
    args = ap.parse_args()

    db = monitor_db.connect()
    if args.map_only:
        for scene_id in args.scenes:
            region = db.execute("SELECT region FROM scenes WHERE id=?", (scene_id,)).fetchone()["region"]
            warped = warp_scene(scene_dir(scene_id), REGIONS[region])
            if warped:
                save_quicklook(warped[0], warped[1], scene_dir(scene_id))
                save_map_image(warped[0], warped[1], scene_dir(scene_id))
                del warped
                (scene_dir(scene_id) / "warped.npy").unlink(missing_ok=True)
                print(f"{scene_id}: map images saved")
        return
    ids = args.scenes or [r["id"] for r in db.execute(
        "SELECT id FROM scenes WHERE status='downloaded' ORDER BY start_ts").fetchall()]
    if not ids:
        print("nothing to do")
        return
    device = pick_device()
    print(f"using {device}")
    models = model.load(device, WINDOW)
    for scene_id in ids:
        try:
            process(db, scene_id, device, models)
        except Exception as exc:
            db.execute("UPDATE scenes SET status='failed', error=? WHERE id=?", (repr(exc), scene_id))
            db.commit()
            raise


if __name__ == "__main__":
    main()
