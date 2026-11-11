"""Shared settings: the area we monitor and where data lives."""

import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("SAR_MONITOR_DATA", REPO / "data"))

# Areas we work on: lon_min, lat_min, lon_max, lat_max
REGIONS = {
    "nl": (2.0, 51.0, 7.5, 56.0),    # Dutch EEZ plus a margin; AIS from our own live recorder
    "dk": (7.0, 54.3, 13.0, 58.0),   # Danish waters; AIS from the Danish Maritime Authority archive
}
AOI = REGIONS["nl"]                  # what the live recorder listens to

AIS_DB = Path(os.environ.get("AIS_DB", DATA / "ais" / "ais.sqlite"))   # live recorder
DMA_DIR = DATA / "ais" / "dma"                                         # Danish archive files
DMA_DB = DMA_DIR / "dma.sqlite"
AIS_SOURCES = {"nl": AIS_DB, "dk": DMA_DB}
MONITOR_DB = DATA / "monitor.sqlite"      # scenes and detections
SCENES_DIR = DATA / "scenes"              # downloaded radar images and detection crops
MODELS_DIR = DATA / "models" / "sentinel-1"
