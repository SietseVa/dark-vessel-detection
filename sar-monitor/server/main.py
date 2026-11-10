"""API for the dark vessel monitor: scenes, radar detections and the AIS ships at each pass.

    uv run uvicorn server.main:app --reload --port 8020
"""

import io
import json
import math
import sqlite3
from contextlib import contextmanager

import numpy as np
import rasterio
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from pipeline.config import MONITOR_DB, SCENES_DIR
from pipeline.infrastructure import OUT as INFRASTRUCTURE

from .nearby import nearest

app = FastAPI(title="Dark Vessel Monitor API")
app.add_middleware(GZipMiddleware, minimum_size=1000)


@contextmanager
def db():
    if not MONITOR_DB.exists():
        raise HTTPException(503, "No data yet. Run the pipeline first.")
    con = sqlite3.connect(f"file:{MONITOR_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


def _scene_folder(scene_id: str):
    folder = (SCENES_DIR / scene_id).resolve()
    if folder.parent != SCENES_DIR.resolve() or not folder.is_dir():
        raise HTTPException(404, "unknown scene")
    return folder


@app.get("/api/scenes")
def scenes():
    """Scenes that have been through detection, newest first, with their counts."""
    with db() as con:
        rows = con.execute(
            """
            SELECT s.id, s.region, s.platform, s.start_ts, s.end_ts, s.orbit_state, s.footprint, s.detect_seconds,
                   (SELECT count(*) FROM detections d WHERE d.scene_id = s.id
                      AND d.id NOT IN (SELECT detection_id FROM echoes)) AS detections,
                   (SELECT count(*) FROM ais_at_pass a WHERE a.scene_id = s.id) AS ais_ships,
                   (SELECT count(*) FROM ais_at_pass a WHERE a.scene_id = s.id AND a.detection_id IS NOT NULL) AS matched
            FROM scenes s WHERE s.status = 'detected' ORDER BY s.start_ts DESC
            """
        ).fetchall()
    out = []
    for r in rows:
        scene = dict(r)
        scene["footprint"] = json.loads(scene["footprint"])["coordinates"][0]
        bounds = SCENES_DIR / r["id"] / "quicklook.json"
        scene["quicklook"] = json.loads(bounds.read_text()) if bounds.exists() else None
        scene["tiles"] = (SCENES_DIR / r["id"] / "map.tif").exists()
        out.append(scene)
    return out


@app.get("/api/scenes/{scene_id}/detections")
def detections(scene_id: str):
    """Radar detections of a scene; mmsi is set when the detection was matched to an AIS ship.

    Second detections on a ship that is already matched are left out.
    """
    with db() as con:
        rows = con.execute(
            """
            SELECT d.id, d.ts, d.lat, d.lon, d.score, d.length_m, d.width_m, d.heading_deg, d.heading_conf,
                   d.speed_kn, d.fishing_score, a.mmsi, a.distance_m
            FROM detections d LEFT JOIN ais_at_pass a ON a.detection_id = d.id
            WHERE d.scene_id = ? AND d.id NOT IN (SELECT detection_id FROM echoes) ORDER BY d.id
            """,
            (scene_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["near"] = nearest(r["lon"], r["lat"])   # closest wind farm, platform, pipeline or cable
        out.append(d)
    return out


@app.get("/api/infrastructure")
def infrastructure():
    """Wind farms, platforms, pipelines and cables as GeoJSON."""
    if not INFRASTRUCTURE.exists():
        raise HTTPException(404, "No infrastructure data. Run: uv run python -m pipeline.infrastructure")
    return FileResponse(INFRASTRUCTURE, media_type="application/geo+json", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/scenes/{scene_id}/ais")
def ais(scene_id: str):
    """Ships that were broadcasting AIS inside the image at the moment of the pass."""
    with db() as con:
        rows = con.execute("SELECT * FROM ais_at_pass WHERE scene_id = ? ORDER BY mmsi", (scene_id,)).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/scenes/{scene_id}/quicklook.png")
def quicklook(scene_id: str):
    path = _scene_folder(scene_id) / "quicklook.png"
    if not path.exists():
        raise HTTPException(404, "no quicklook for this scene")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/scenes/{scene_id}/crops/{number}/{pol}.png")
def crop(scene_id: str, number: int, pol: str):
    """The 128 x 128 pixel radar cut-out around a detection, VV or VH."""
    if pol not in ("vv", "vh", "before"):
        raise HTTPException(404, "pol must be vv, vh or before")
    path = _scene_folder(scene_id) / "crops" / f"{number}_{pol}.png"
    if not path.exists():
        raise HTTPException(404, "no crop for this detection")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


WEB_MERCATOR_HALF = math.pi * 6378137
TILE = 256


@app.get("/api/scenes/{scene_id}/tiles/{z}/{x}/{y}.png")
def tile(scene_id: str, z: int, x: int, y: int):
    """A map tile of the radar image (VV), cut from the full-resolution image or its overviews."""
    path = _scene_folder(scene_id) / "map.tif"
    if not path.exists() or not (0 <= z <= 22 and 0 <= x < 2**z and 0 <= y < 2**z):
        raise HTTPException(404, "no tile")
    size = 2 * WEB_MERCATOR_HALF / 2**z
    left = -WEB_MERCATOR_HALF + x * size
    top = WEB_MERCATOR_HALF - y * size
    with rasterio.open(path) as src:
        b = src.bounds
        if left >= b.right or left + size <= b.left or top <= b.bottom or top - size >= b.top:
            raise HTTPException(404, "outside the image")
        window = from_bounds(left, top - size, left + size, top, src.transform)
        vv = src.read(1, window=window, out_shape=(TILE, TILE), boundless=True, fill_value=0,
                      resampling=Resampling.bilinear).astype(np.float32)
    rgba = np.zeros((TILE, TILE, 4), dtype=np.uint8)
    grey = (np.clip(vv / 160, 0, 1) ** 0.6 * 255).astype(np.uint8)   # brighten the dark sea a little
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = grey
    rgba[..., 3] = np.where(vv > 0, 255, 0)                         # outside the radar swath is transparent
    out = io.BytesIO()
    Image.fromarray(rgba).save(out, format="PNG")
    return Response(out.getvalue(), media_type="image/png", headers={"Cache-Control": "max-age=3600"})
