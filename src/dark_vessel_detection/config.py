"""Paths shared by the API and the batch prediction. Every path can be overridden with an env var.

The CLI turns its options into these env vars, so the API also sees them when uvicorn reloads it in
a fresh process.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# The package lives in <repo>/src/dark_vessel_detection/.
REPO = Path(__file__).resolve().parents[2]
FRONTEND_DIR = REPO / "frontend"


def _default_data_dir() -> Path:
    # The dataset is either in data/xview3_tiles/ or unpacked directly into data/.
    nested = REPO / "data" / "xview3_tiles"
    return nested if nested.exists() or not (REPO / "data" / "meta").exists() else REPO / "data"


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value) if value else default


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    cache_dir: Path
    thumb_dir: Path
    predictions_dir: Path
    runs_dir: Path
    sentinel_dir: Path
    ais_db_path: Path
    model_path: Path | None = None

    @classmethod
    def from_env(cls) -> Settings:
        cache_dir = _env_path("CACHE_DIR", REPO / "data" / "cache")
        model_path = os.environ.get("MODEL_PATH")
        return cls(
            data_dir=_env_path("DATA_DIR", _default_data_dir()),
            cache_dir=cache_dir,
            thumb_dir=_env_path("THUMB_DIR", cache_dir / "thumbs"),
            predictions_dir=_env_path("PREDICTIONS_DIR", cache_dir / "predictions"),
            runs_dir=_env_path("RUNS_DIR", REPO / "runs"),
            sentinel_dir=_env_path("SENTINEL_DATA_DIR", REPO / "data" / "sentinel1"),
            ais_db_path=_env_path("AIS_DB_PATH", REPO / "data" / "monitor.sqlite"),
            model_path=Path(model_path) if model_path else None,
        )

    @property
    def has_dataset(self) -> bool:
        return (self.data_dir / "meta" / "tiles.csv").exists()

    def weights(self) -> Path | None:
        """MODEL_PATH, the configured final model, or the newest weights under runs/."""
        if self.model_path:
            return self.model_path
        preferred = self.runs_dir / "detect" / "yolo26m-vessels-FINAL" / "weights" / "best.pt"
        if preferred.exists():
            return preferred
        runs = self.runs_dir
        candidates = list(runs.glob("**/weights/best.pt")) or list(runs.glob("**/weights/last.pt"))
        return max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None
