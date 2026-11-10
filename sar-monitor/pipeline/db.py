"""The monitor database: Sentinel-1 scenes and the vessels detected in them."""

import sqlite3

from .config import MONITOR_DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,          -- e.g. S1C_IW_GRDH_1SDV_20261109T060535_20261109T060600_010256_0147B6
    region TEXT NOT NULL,         -- key of config.REGIONS
    platform TEXT NOT NULL,
    start_ts REAL NOT NULL,       -- UTC epoch seconds
    end_ts REAL NOT NULL,
    orbit_state TEXT,             -- ascending / descending
    relative_orbit INTEGER,
    footprint TEXT NOT NULL,      -- GeoJSON polygon
    vv_href TEXT NOT NULL,
    vh_href TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'found',   -- found, downloaded, detected, failed
    detected_at REAL,
    detect_seconds REAL,
    error TEXT
);
CREATE INDEX IF NOT EXISTS scenes_start ON scenes (start_ts);

CREATE TABLE IF NOT EXISTS detections (
    id TEXT PRIMARY KEY,          -- <scene id>_<n>
    scene_id TEXT NOT NULL REFERENCES scenes (id),
    ts REAL NOT NULL,             -- UTC epoch seconds when the radar passed this spot (approximate)
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    score REAL NOT NULL,
    length_m REAL,
    width_m REAL,
    heading_deg REAL,             -- most likely of 16 heading buckets; ambiguous by 180 degrees
    heading_conf REAL,
    speed_kn REAL,
    fishing_score REAL,
    px_row INTEGER NOT NULL,      -- position in the warped scene image
    px_col INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS detections_scene ON detections (scene_id);

-- Every ship that was broadcasting AIS inside the image at the moment of the pass.
CREATE TABLE IF NOT EXISTS ais_at_pass (
    scene_id TEXT NOT NULL REFERENCES scenes (id),
    mmsi INTEGER NOT NULL,
    lat REAL NOT NULL,            -- where AIS says the ship was
    lon REAL NOT NULL,
    sar_lat REAL NOT NULL,        -- where it should appear in the radar image (moving ships are shifted)
    sar_lon REAL NOT NULL,
    sog_kn REAL,
    cog_deg REAL,
    heading_deg REAL,
    age_s REAL NOT NULL,          -- seconds between the pass and the nearest AIS message
    method TEXT NOT NULL,         -- interpolated / extrapolated
    name TEXT,
    ship_type TEXT,
    length_m REAL,
    width_m REAL,
    detection_id TEXT,            -- the radar detection it was matched to, if any
    distance_m REAL,
    PRIMARY KEY (scene_id, mmsi)
);
CREATE INDEX IF NOT EXISTS ais_at_pass_detection ON ais_at_pass (detection_id);

-- Extra detections on a ship that is already matched (long ships can be detected twice).
CREATE TABLE IF NOT EXISTS echoes (
    detection_id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL,
    mmsi INTEGER NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    MONITOR_DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(MONITOR_DB)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    return db
