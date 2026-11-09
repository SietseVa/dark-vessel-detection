"""Area, waters and storage settings."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "gfw.sqlite"

# The North Sea, including UK and Norwegian waters (lon_min, lat_min, lon_max, lat_max).
BBOX = (-4.0, 50.5, 10.5, 62.0)

# Exclusive Economic Zones around the North Sea, by GFW/Marine Regions id.
EEZ = {
    "NLD": (5668, "Netherlands"),
    "BEL": (3293, "Belgium"),
    "DEU": (5669, "Germany"),
    "DNK": (5674, "Denmark"),
    "NOR": (5686, "Norway"),
    "GBR": (5696, "United Kingdom"),
    "FRA": (5677, "France"),
}
EEZ_BY_ID = {str(v[0]): k for k, v in EEZ.items()}

DEFAULT_DAYS = 90
