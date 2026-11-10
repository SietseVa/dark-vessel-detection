"""FastAPI backend for the dark-vessel dashboard.

Start it with `dvd dashboard` (API + frontend) or `dvd api` (API only).
"""

from __future__ import annotations

from io import BytesIO

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image

from .config import Settings
from .dataset import Dataset
from .live import LiveAnalysisStore
from .model import Detector
from .predictions import PredictionStore


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if not settings.has_dataset:
        raise RuntimeError(f"Dataset not found at {settings.data_dir}. Put xview3_tiles there or set DATA_DIR.")

    ds = Dataset.load(settings.data_dir)

    # The model is optional: without weights the dashboard still shows the dataset.
    weights = settings.weights()
    detector = Detector(weights) if weights and weights.exists() else None
    store = PredictionStore(ds, detector, settings.predictions_dir) if detector else None
    live = LiveAnalysisStore(settings.sentinel_dir, settings.ais_db_path, settings.cache_dir, detector)

    app = FastAPI(title="Dark Vessel Detection API")
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    def tile_or_404(tile_id: str) -> dict:
        tile = ds.tiles.get(tile_id)
        if tile is None:
            raise HTTPException(404, f"unknown tile {tile_id}")
        return tile

    def store_or_404() -> PredictionStore:
        if store is None:
            raise HTTPException(404, f"no model weights found under {settings.runs_dir}; set MODEL_PATH")
        return store

    def require_live_data() -> None:
        if not settings.sentinel_dir.is_dir():
            raise HTTPException(503, f"Sentinel-1 data directory not found at {settings.sentinel_dir}")
        if not settings.ais_db_path.is_file():
            raise HTTPException(503, f"AIS database not found at {settings.ais_db_path}")

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
        t = tile_or_404(tile_id)
        return {**t, "objects": [o for o in ds.objects if o["tile_id"] == tile_id]}

    @app.get("/api/tiles/{tile_id}/image")
    def tile_image(tile_id: str):
        tile_or_404(tile_id)
        return FileResponse(ds.image_path(tile_id), media_type="image/png",
                            headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/api/tiles/{tile_id}/thumb")
    def tile_thumb(tile_id: str, size: int = Query(192, ge=32, le=640)):
        tile_or_404(tile_id)
        cached = settings.thumb_dir / str(size) / f"{tile_id}.jpg"
        if not cached.exists():
            cached.parent.mkdir(parents=True, exist_ok=True)
            img = Image.open(ds.image_path(tile_id)).convert("RGB")
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            buf = BytesIO()
            img.save(buf, "JPEG", quality=85)
            cached.write_bytes(buf.getvalue())
        return Response(cached.read_bytes(), media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/api/model")
    def model_info():
        if store is None:
            return {"available": False}
        return {
            "available": True,
            **store.detector.info(),
            "predicted_tiles": len(store.tile_ids),
            "best_vessel_threshold": store.best_vessel_threshold("val"),
        }

    @app.get("/api/predictions")
    def predictions():
        """All cached detections (fill the cache with `dvd predict`)."""
        return store_or_404().all()

    @app.get("/api/tiles/{tile_id}/detections")
    def tile_detections(tile_id: str):
        """Detections for one tile; runs the model if the tile is not cached yet."""
        tile_or_404(tile_id)
        return store_or_404().for_tile(tile_id)

    @app.get("/api/live/scenes")
    def live_scenes():
        require_live_data()
        return live.scenes()

    @app.post("/api/live/scenes/{scene_key}/analyze")
    def analyze_live_scene(scene_key: str):
        require_live_data()
        if live.detector is None:
            raise HTTPException(404, f"no model weights found under {settings.runs_dir}; set MODEL_PATH")
        try:
            return live.analyze(scene_key)
        except FileNotFoundError as e:
            raise HTTPException(404, str(e)) from e

    @app.get("/api/live/scenes/{scene_key}/tiles")
    def live_scene_tiles(scene_key: str):
        require_live_data()
        try:
            return live.tiles(scene_key)
        except FileNotFoundError as e:
            raise HTTPException(404, str(e)) from e

    @app.get("/api/live/scenes/{scene_key}/tiles/{tile_id}/image")
    def live_tile_image(scene_key: str, tile_id: str):
        require_live_data()
        try:
            image_path = live.tile_image(scene_key, tile_id)
        except FileNotFoundError as e:
            raise HTTPException(404, str(e)) from e
        return FileResponse(image_path, media_type="image/png",
                            headers={"Cache-Control": "public, max-age=86400"})

    return app
