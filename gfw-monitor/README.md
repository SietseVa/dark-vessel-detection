# North Sea Dark Vessel Monitor

A separate web app that shows **dark vessels in the North Sea** using only data from
[Global Fishing Watch](https://globalfishingwatch.org) (GFW):

- **Sentinel-1 radar detections**, each marked by GFW as *matched* to an AIS signal or *dark* (no AIS).
- **AIS traffic density** for context.
- **Fishing and loitering events** from AIS, with vessel name, flag and type.

No model of our own is involved: GFW detects the vessels, removes fixed infrastructure such as wind
turbines and platforms, and matches the detections against AIS (including satellite AIS).

## Run it

You need [uv](https://docs.astral.sh/uv/), Node.js 20+ and a GFW API token
(`GFW_TOKEN` in the repo's `.env`; get one at https://globalfishingwatch.org/our-apis/tokens).

1. Download the data (90 days of the North Sea, ~5 minutes, ~60 MB):

   ```bash
   cd gfw-monitor && uv run python -m server.sync
   ```

   Use `--days 30` for a shorter period. Re-run it to refresh; the app keeps working meanwhile.

2. Start the API:

   ```bash
   cd gfw-monitor && uv run uvicorn server.main:app --reload --port 8010
   ```

3. Start the web app in a second terminal and open http://localhost:5190:

   ```bash
   cd gfw-monitor/web && npm install && npm run dev
   ```

## How it is built

| Part | What |
|---|---|
| `server/sync.py` | Downloads GFW data for the North Sea box (4°W–10.5°E, 50.5°N–62°N) into `data/gfw.sqlite`. Radar detections are tagged with their EEZ (NL, BE, DE, DK, NO, UK, FR) by querying GFW per EEZ. |
| `server/main.py` | FastAPI serving the local database: `/api/meta`, `/api/detections`, `/api/presence`, `/api/events`. The GFW token never reaches the browser. |
| `web/` | React + Vite + TypeScript, shadcn/ui (base theme), MapLibre + deck.gl, Recharts. |

## Limits

- **About 5 days behind**: GFW publishes radar detections ~5 days after the satellite pass, AIS ~4 days.
- **~1 km precision**: detections are snapped to GFW's 0.01° grid; AIS density uses a 0.1° grid.
- **No vessel identity for detections**: GFW has temporarily paused the per-vessel part of its API.
- **"Dark" is not "illegal"**: it means no public AIS signal was matched. Small boats are often not required
  to carry AIS, and GFW detects vessels under ~25 m less reliably.
- **Licence**: GFW data is free for non-commercial use with attribution to Global Fishing Watch.
