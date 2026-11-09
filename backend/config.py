"""Paths shared by the API and the batch prediction script. All can be overridden with env vars."""

from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _default_data_dir() -> Path:
    # The dataset is either in data/xview3_tiles/ or unpacked directly into data/.
    nested = REPO / "data" / "xview3_tiles"
    return nested if nested.exists() or not (REPO / "data" / "meta").exists() else REPO / "data"


DATA_DIR = Path(os.environ.get("DATA_DIR", _default_data_dir()))
CACHE_DIR = Path(os.environ.get("CACHE_DIR", REPO / "data" / "cache"))
THUMB_DIR = Path(os.environ.get("THUMB_DIR", CACHE_DIR / "thumbs"))
PREDICTIONS_DIR = Path(os.environ.get("PREDICTIONS_DIR", CACHE_DIR / "predictions"))
RUNS_DIR = Path(os.environ.get("RUNS_DIR", REPO / "runs"))
