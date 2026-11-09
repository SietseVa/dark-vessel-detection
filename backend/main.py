"""FastAPI backend for the dark-vessel dashboard.

Run from the repo root:
    uv run uvicorn backend.main:app --reload --port 8000
"""

from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image

from .dataset import Dataset

REPO = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", REPO / "data" / "xview3_tiles"))
THUMB_DIR = Path(os.environ.get("THUMB_DIR", REPO / "data" / "cache" / "thumbs"))

if not (DATA_DIR / "meta" / "tiles.csv").exists():
    raise RuntimeError(f"Dataset not found at {DATA_DIR}. Put xview3_tiles there or set DATA_DIR.")

ds = Dataset.load(DATA_DIR)

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
