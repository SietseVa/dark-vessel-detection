"""FastAPI backend for the dark-vessel dashboard.

Run from the repo root:
    uv run uvicorn backend.main:app --reload --port 8000
"""

from __future__ import annotations

from io import BytesIO

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image

from .config import DATA_DIR, PREDICTIONS_DIR, RUNS_DIR, THUMB_DIR
from .dataset import Dataset
from .model import Detector, find_weights
from .predictions import PredictionStore

if not (DATA_DIR / "meta" / "tiles.csv").exists():
    raise RuntimeError(f"Dataset not found at {DATA_DIR}. Put xview3_tiles there or set DATA_DIR.")

ds = Dataset.load(DATA_DIR)

# The model is optional: without weights the dashboard still shows the dataset.
_weights = find_weights(RUNS_DIR)
store = PredictionStore(ds, Detector(_weights), PREDICTIONS_DIR) if _weights and _weights.exists() else None

app = FastAPI(title="Dark Vessel Detection API")
app.add_middleware(GZipMiddleware, minimum_size=1000)


def _tile_or_404(tile_id: str) -> dict:
    tile = ds.tiles.get(tile_id)
    if tile is None:
        raise HTTPException(404, f"unknown tile {tile_id}")
    return tile


@app.get("/api/summary")
def summary():
    return ds.summary()


@app.get("/api/scenes")
def scenes():
    return list(ds.scenes.values())


@app.get("/api/tiles")
def tiles():
    return list(ds.tiles.values())


@app.get("/api/objects")
def objects():
    return ds.objects


@app.get("/api/tiles/{tile_id}")
def tile(tile_id: str):
    t = _tile_or_404(tile_id)
    return {**t, "objects": [o for o in ds.objects if o["tile_id"] == tile_id]}


@app.get("/api/tiles/{tile_id}/image")
def tile_image(tile_id: str):
    _tile_or_404(tile_id)
    return FileResponse(ds.image_path(tile_id), media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/tiles/{tile_id}/thumb")
def tile_thumb(tile_id: str, size: int = Query(192, ge=32, le=640)):
    _tile_or_404(tile_id)
    cached = THUMB_DIR / str(size) / f"{tile_id}.jpg"
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        img = Image.open(ds.image_path(tile_id)).convert("RGB")
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        buf = BytesIO()
        img.save(buf, "JPEG", quality=85)
        cached.write_bytes(buf.getvalue())
    return Response(cached.read_bytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"})


def _store_or_404() -> PredictionStore:
    if store is None:
        raise HTTPException(404, f"no model weights found under {RUNS_DIR}; set MODEL_PATH")
    return store


@app.get("/api/model")
def model_info():
    if store is None:
        return {"available": False}
    return {"available": True, **store.detector.info(), "predicted_tiles": len(store.tile_ids)}


@app.get("/api/predictions")
def predictions():
    """All cached detections (fill the cache with `python -m backend.predict`)."""
    return _store_or_404().all()


@app.get("/api/tiles/{tile_id}/detections")
def tile_detections(tile_id: str):
    """Detections for one tile; runs the model if the tile is not cached yet."""
    _tile_or_404(tile_id)
    return _store_or_404().for_tile(tile_id)
