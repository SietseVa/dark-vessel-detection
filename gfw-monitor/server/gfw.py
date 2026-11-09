"""Small client for the Global Fishing Watch API (v3).

Only the endpoints this app needs: 4Wings reports (radar detections, AIS presence) and events.
The token is read from GFW_TOKEN (environment) or from a .env file in this folder or the repo root.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests

API = "https://gateway.api.globalfishingwatch.org/v3"
SAR = "public-global-sar-presence:latest"
PRESENCE = "public-global-presence:latest"
FISHING = "public-global-fishing-events:latest"
LOITERING = "public-global-loitering-events:latest"

HERE = Path(__file__).resolve().parent.parent


def load_token() -> str:
    if os.environ.get("GFW_TOKEN"):
        return os.environ["GFW_TOKEN"]
    for env in (HERE / ".env", HERE.parent / ".env"):
        if env.exists():
            for line in env.read_text().splitlines():
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:]
                if line.startswith("GFW_TOKEN="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit("No GFW_TOKEN found. Set it in the environment or in .env (see env.example).")


class GFW:
    def __init__(self, token: str | None = None):
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token or load_token()}"

    def _request(self, method: str, path: str, **kw) -> requests.Response:
        for attempt in range(8):
            try:
                r = self.s.request(method, f"{API}{path}", timeout=300, **kw)
            except (requests.ConnectionError, requests.Timeout):
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(60, 5 * (attempt + 1)))
                continue
            if not r.ok:
                raise RuntimeError(f"GFW {r.status_code} on {path}: {r.text[:300]}")
            return r
        raise RuntimeError(f"GFW: too many retries on {path}")

    def report(
        self,
        dataset: str,
        start: str,
        end: str,
        *,
        geometry: dict | None = None,
        region: tuple[str, int] | None = None,
        resolution: str = "HIGH",
        temporal: str = "HOURLY",
        filters: list[str] | None = None,
    ) -> list[dict]:
        """4Wings report; end date is exclusive. Returns the flat list of grid-cell rows."""
        params = {
            "datasets[0]": dataset,
            "spatial-resolution": resolution,
            "temporal-resolution": temporal,
            "date-range": f"{start},{end}",
            "format": "JSON",
        }
        for i, f in enumerate(filters or []):
            params[f"filters[{i}]"] = f
        body = {"region": {"dataset": region[0], "id": region[1]}} if region else {"geojson": geometry}
        r = self._request("POST", "/4wings/report", params=params, json=body)
        rows: list[dict] = []
        for entry in r.json().get("entries", []):
            for v in entry.values():
                rows.extend(v or [])
        return rows

    def events(self, dataset: str, start: str, end: str, geometry: dict, page: int = 1000):
        """Yield all events of a dataset that intersect [start, end) within the geometry."""
        offset = 0
        while True:
            r = self._request(
                "POST",
                "/events",
                params={"limit": page, "offset": offset},
                json={"datasets": [dataset], "startDate": start, "endDate": end, "geometry": geometry},
            )
            j = r.json()
            yield from j.get("entries", [])
            nxt = j.get("nextOffset")
            if not nxt or nxt <= offset or not j.get("entries"):
                return
            offset = nxt


def polygon(bbox: tuple[float, float, float, float]) -> dict:
    x0, y0, x1, y1 = bbox
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def dumps(o) -> str:
    return json.dumps(o, separators=(",", ":"))
