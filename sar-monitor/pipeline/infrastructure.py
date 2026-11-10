"""Download offshore infrastructure for the map: wind farms, platforms, pipelines and cables.

    uv run python -m pipeline.infrastructure

Sources:
- EMODnet Human Activities (https://emodnet.ec.europa.eu/en/human-activities): wind farms,
  offshore installations and pipelines.
- OpenStreetMap (© OpenStreetMap contributors, ODbL): submarine power and telecom cables.
  EMODnet has no cable data for Danish or Dutch waters.

Everything is written to one GeoJSON file. Each feature gets the same few properties:
kind (wind_farm / platform / pipeline / power_cable / telecom_cable), name, status, detail.
"""

import json

import requests

from .config import DATA, REGIONS

OUT = DATA / "infrastructure" / "infrastructure.geojson"
EMODNET = "https://ows.emodnet-humanactivities.eu/wfs"
OVERPASS = "https://overpass-api.de/api/interpreter"

# One box around all regions: lon_min, lat_min, lon_max, lat_max
BBOX = (
    min(r[0] for r in REGIONS.values()), min(r[1] for r in REGIONS.values()),
    max(r[2] for r in REGIONS.values()), max(r[3] for r in REGIONS.values()),
)


def _round(coords):
    """Coordinates to 5 decimals (about 1 m): keeps the file small."""
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 5), round(coords[1], 5)]
    return [_round(c) for c in coords]


def _text(*parts) -> str | None:
    return ", ".join(str(p) for p in parts if p not in (None, "", " ")) or None


def emodnet(layer: str) -> list[dict]:
    r = requests.get(EMODNET, timeout=180, params={
        "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": f"emodnet:{layer}",
        "outputFormat": "application/json", "srsName": "EPSG:4326",
        "bbox": f"{BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]},EPSG:4326",
    })
    r.raise_for_status()
    return [f for f in r.json()["features"] if f.get("geometry")]


def feature(kind: str, geometry: dict, name, status, detail) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": geometry["type"], "coordinates": _round(geometry["coordinates"])},
        "properties": {"kind": kind, "name": name or None, "status": status or None, "detail": detail},
    }


def wind_farms() -> list[dict]:
    out = []
    for f in emodnet("windfarmspoly"):
        p = f["properties"]
        detail = _text(f"{p['n_turbines']} turbines" if p.get("n_turbines") else None,
                       f"{p['power_mw']:.0f} MW" if p.get("power_mw") else None, p.get("country"))
        out.append(feature("wind_farm", f["geometry"], p.get("name"), p.get("status"), detail))
    return out


def platforms() -> list[dict]:
    out = []
    for f in emodnet("platforms"):
        p = f["properties"]
        out.append(feature("platform", f["geometry"], p.get("name"), p.get("current_status"),
                           _text(p.get("function"), p.get("primary_production"), p.get("operator"))))
    return out


def pipelines() -> list[dict]:
    out = []
    for f in emodnet("pipelines"):
        p = f["properties"]
        route = _text(p.get("from_loc"), p.get("to_loc"))
        out.append(feature("pipeline", f["geometry"], p.get("name") or route, p.get("status"),
                           _text(p.get("medium"), p.get("operator"))))
    return out


def cables() -> list[dict]:
    south, west, north, east = BBOX[1], BBOX[0], BBOX[3], BBOX[2]
    box = f"({south},{west},{north},{east})"
    query = (
        "[out:json][timeout:120];("
        f'way["seamark:type"="cable_submarine"]{box};'
        f'way["communication"="line"]["submarine"="yes"]{box};'
        f'way["telecom"="line"]["location"="underwater"]{box};'
        f'way["power"="cable"]["location"="underwater"]{box};'
        ");out tags geom;"
    )
    r = requests.post(OVERPASS, data={"data": query}, timeout=180, headers={"User-Agent": "sar-monitor"})
    r.raise_for_status()
    out = []
    for way in r.json()["elements"]:
        t = way.get("tags", {})
        category = t.get("seamark:cable_submarine:category", "")
        if t.get("power") == "cable" or category in ("power", "transmission"):
            kind = "power_cable"
            detail = _text(f"{int(t['voltage']) // 1000} kV" if t.get("voltage", "").isdigit() else None,
                           t.get("operator"))
        elif t.get("communication") or t.get("telecom") or category:
            kind = "telecom_cable"
            detail = _text(category.replace("_", " ") or None, t.get("operator"))
        else:
            kind = "telecom_cable"       # charted as a submarine cable with no further detail
            detail = "type not recorded"
        line = {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in way["geometry"]]}
        out.append(feature(kind, line, t.get("name"), None, detail))
    return out


def main() -> None:
    features = []
    for label, load in (("wind farms", wind_farms), ("platforms", platforms),
                        ("pipelines", pipelines), ("cables", cables)):
        found = load()
        print(f"{label}: {len(found)}")
        features += found
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
