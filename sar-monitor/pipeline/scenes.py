"""Find and download Sentinel-1 scenes over the area of interest.

Source: Microsoft Planetary Computer's `sentinel-1-grd` collection. It mirrors ESA's
IW GRDH products as cloud-optimised GeoTIFFs (raw digital numbers, georeferenced with
ground control points) and needs no account: links are signed anonymously.

    uv run python -m pipeline.scenes --days 3              # list recent scenes off the Dutch coast
    uv run python -m pipeline.scenes --days 3 --download   # and download them
    uv run python -m pipeline.scenes --region dk --start 2025-02-24T17:00 --end 2025-02-24T17:05
"""

import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from . import db as monitor_db
from .config import REGIONS, SCENES_DIR

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SIGN = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"
COLLECTION = "sentinel-1-grd"


def _epoch(text: str) -> float:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def search(region: str, start: datetime, end: datetime) -> list[dict]:
    """Scenes that intersect the region and were taken between start and end, newest first."""
    body = {
        "collections": [COLLECTION],
        "bbox": list(REGIONS[region]),
        "datetime": f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "query": {"sar:instrument_mode": {"eq": "IW"}},
        "limit": 100,
    }
    items, url = [], STAC
    while url:
        r = requests.post(url, json=body, timeout=60)
        r.raise_for_status()
        page = r.json()
        items += page["features"]
        nxt = next((l for l in page.get("links", []) if l["rel"] == "next"), None)
        url, body = (nxt["href"], nxt.get("body", body)) if nxt else (None, body)
    unique = {}  # the catalogue lists some scenes twice, pointing at the same files
    for i in items:
        if "vv" in i["assets"] and "vh" in i["assets"]:
            href = i["assets"]["vv"]["href"]
            if href not in unique or len(i["id"]) > len(unique[href]["id"]):
                unique[href] = i
    return sorted(unique.values(), key=lambda i: i["properties"]["start_datetime"], reverse=True)


def register(db, region: str, items: list[dict]) -> list[str]:
    """Store scenes we have not seen before; returns their ids."""
    new = []
    for item in items:
        p = item["properties"]
        cur = db.execute(
            "INSERT OR IGNORE INTO scenes (id, region, platform, start_ts, end_ts, orbit_state, relative_orbit,"
            " footprint, vv_href, vh_href) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (item["id"], region, p.get("platform"), _epoch(p["start_datetime"]), _epoch(p["end_datetime"]),
             p.get("sat:orbit_state"), p.get("sat:relative_orbit"), json.dumps(item["geometry"]),
             item["assets"]["vv"]["href"], item["assets"]["vh"]["href"]),
        )
        if cur.rowcount:
            new.append(item["id"])
    db.commit()
    return new


def scene_dir(scene_id: str) -> Path:
    return SCENES_DIR / scene_id


def _fetch(href: str, dest: Path) -> None:
    signed = requests.get(SIGN, params={"href": href}, timeout=60)
    signed.raise_for_status()
    tmp = dest.with_suffix(".part")
    with requests.get(signed.json()["href"], stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 22):
                f.write(chunk)
    tmp.rename(dest)


def fetch_history(scene, count: int = 2) -> list[list[Path]]:
    """Download earlier images of the same place, taken from the same orbit.

    The detector compares the scene with these to ignore things that never move
    (wind turbines, platforms). Sentinel-1 repeats an orbit every 6 or 12 days, so we
    look back in 6-day steps for the `count` most recent dates that have an image.
    Returns one list of folders per date, newest first.
    """
    cache = scene_dir(scene["id"]) / "history.json"
    if cache.exists():
        return [[SCENES_DIR / name for name in group] for group in json.loads(cache.read_text())]

    footprint = json.loads(scene["footprint"])["coordinates"][0]
    lons, lats = [p[0] for p in footprint], [p[1] for p in footprint]
    groups = []
    for step in range(1, 9):
        back = step * 6 * 86400
        lo = datetime.fromtimestamp(scene["start_ts"] - back - 60, timezone.utc)
        hi = datetime.fromtimestamp(scene["end_ts"] - back + 60, timezone.utc)
        body = {
            "collections": [COLLECTION],
            "bbox": [min(lons), min(lats), max(lons), max(lats)],
            "datetime": f"{lo.strftime('%Y-%m-%dT%H:%M:%SZ')}/{hi.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            "limit": 50,
        }
        r = requests.post(STAC, json=body, timeout=60)
        r.raise_for_status()
        files = {}
        for item in r.json()["features"]:
            p = item["properties"]
            if p.get("sat:relative_orbit") != scene["relative_orbit"] or "vh" not in item["assets"]:
                continue
            # keep the slices that cover the same stretch of the orbit as our scene
            overlap = (min(_epoch(p["end_datetime"]) + back, scene["end_ts"])
                       - max(_epoch(p["start_datetime"]) + back, scene["start_ts"]))
            if overlap >= 5:
                files[item["assets"]["vv"]["href"]] = item
        if not files:
            continue
        folders = []
        for item in files.values():
            name = item["assets"]["vv"]["href"].split("/")[-3]   # the product name
            folder = SCENES_DIR / name
            folder.mkdir(parents=True, exist_ok=True)
            for pol in ("vv", "vh"):
                if not (folder / f"{pol}.tiff").exists():
                    print(f"  history {name[:32]} {pol}")
                    _fetch(item["assets"][pol]["href"], folder / f"{pol}.tiff")
            folders.append(folder)
        groups.append(folders)
        if len(groups) == count:
            break
    cache.write_text(json.dumps([[f.name for f in group] for group in groups]))
    return groups


def download(db, scene_id: str) -> Path:
    """Download the VV and VH images of a scene (about 1.5 GB together)."""
    row = db.execute("SELECT vv_href, vh_href FROM scenes WHERE id=?", (scene_id,)).fetchone()
    if row is None:
        raise SystemExit(f"unknown scene {scene_id}: run a search first")
    folder = scene_dir(scene_id)
    folder.mkdir(parents=True, exist_ok=True)
    for pol in ("vv", "vh"):
        dest = folder / f"{pol}.tiff"
        if not dest.exists():
            started = time.time()
            _fetch(row[f"{pol}_href"], dest)
            print(f"  {pol}: {dest.stat().st_size / 1e6:.0f} MB in {time.time() - started:.0f}s")
    db.execute("UPDATE scenes SET status='downloaded' WHERE id=? AND status='found'", (scene_id,))
    db.commit()
    return folder


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", choices=REGIONS, default="nl")
    ap.add_argument("--days", type=float, default=2, help="look back this many days (default 2)")
    ap.add_argument("--start", help="UTC start, e.g. 2025-02-24T17:00 (instead of --days)")
    ap.add_argument("--end", help="UTC end; default now")
    ap.add_argument("--download", action="store_true", help="also download the scenes found")
    args = ap.parse_args()

    def utc(text):
        return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)

    end = utc(args.end) if args.end else datetime.now(timezone.utc)
    start = utc(args.start) if args.start else end - timedelta(days=args.days)
    db = monitor_db.connect()
    items = search(args.region, start, end)
    new = register(db, args.region, items)
    print(f"{len(items)} scenes for {args.region} between {start:%Y-%m-%d %H:%M} and {end:%Y-%m-%d %H:%M} UTC, "
          f"{len(new)} new")
    for item in items:
        p = item["properties"]
        print(f"  {item['id']}  {p['start_datetime'][:19]}Z  {p.get('sat:orbit_state')}")
    if args.download:
        for item in items:
            print(f"downloading {item['id']}")
            download(db, item["id"])


if __name__ == "__main__":
    main()
