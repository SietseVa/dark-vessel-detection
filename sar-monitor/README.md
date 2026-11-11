# Dark Vessel Monitor (own detection + own AIS matching)

Finds ships on Sentinel-1 radar images with a public detection model, compares them with the
ships that were broadcasting AIS at the same moment, and shows the result in a web app.
A detection with no AIS ship nearby is a **dark candidate**.

| Part | Source |
|---|---|
| Radar images | Sentinel-1 IW GRDH from [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/dataset/sentinel-1-grd) (mirror of Copernicus, no account needed) |
| Detection model | [Ai2 Skylight `vessel-detection-sentinels`](https://github.com/allenai/vessel-detection-sentinels), Apache 2.0. Weights are downloaded on first use |
| AIS, Danish waters | [Danish Maritime Authority archive](http://aisdata.ais.dk): exact positions, 2006 until about three days ago |
| Infrastructure overlay | Wind farms, platforms and pipelines from [EMODnet Human Activities](https://emodnet.ec.europa.eu/en/human-activities); submarine cables from OpenStreetMap (© OpenStreetMap contributors) |
| AIS, Dutch coast | Our own recording of [aisstream.io](https://aisstream.io) (live only, no history) |

## Run the Danish demo

You need [uv](https://docs.astral.sh/uv/) and Node.js 20+. Run everything from `sar-monitor/`.

```bash
# 1. Find and download the scene (about 1 GB)
uv run python -m pipeline.scenes --region dk --start 2025-02-24T17:01:50 --end 2025-02-24T17:02:00 --download

# 2. Load the AIS around the pass (downloads a 0.6 GB day file once)
uv run python -m pipeline.dma 2025-02-24 --around 17:02 --minutes 45

# 3. Detect vessels (downloads two earlier images, about 16 minutes on an Apple M-series GPU)
uv run python -m pipeline.detect

# 4. Match detections with AIS
uv run python -m pipeline.match

# 5. Optional: download the infrastructure overlay (wind farms, platforms, pipelines, cables)
uv run python -m pipeline.infrastructure

# 6. Start the API and the web app, then open http://localhost:5200
uv run uvicorn server.main:app --port 8020
cd web && npm install && npm run dev
```

## How it works

### Imported tiles and YOLO

The **YOLO tiles** page at `http://localhost:5200/#yolo-tiles` displays an imported
scene as a selectable mosaic, individual full-resolution RGB tiles, YOLO boxes,
and archived AIS positions at the acquisition time. The original SAR monitor
remains available in the other navigation tab.

From `sar-monitor/`, import and run inference with:

```bash
uv sync
uv run python -m pipeline.yolo_tiles \
  --scene /path/to/scene.json \
  --tiles /path/to/tiles \
  --weights /path/to/yolo26m-vessels-FINAL/weights/best.pt \
  --region dk --overlap 64 --confidence 0.10
```

The default device is CPU; `--device mps` can use an Apple GPU. Input tiles are
copied into `data/yolo-tiles/tiles/`. `results.json` records detections, AIS,
scene geometry, model SHA-256 and inference settings; `overview.jpg` is the mosaic.
These files are local ignored data. The API serves the latest completed run.
The original monitor database is not modified.

Tile filenames end in `_row_col.png`. Their offsets are reconstructed from the
tile size and overlap, then checked against identical overlapping image pixels.
Coordinates use the scene's CRS, upper-left origin and pixel size. Edge padding
is excluded and overlapping detections undergo scene-wide non-maximum suppression.

AIS uses the existing regional archive, interpolating or extrapolating at
`acquired_utc` with a maximum nearest-message age of 600 seconds. Associations are
one-to-one proximity matches within 300 m (`--match-m`), computed at the inference
confidence floor. The display slider filters these fixed results. No radar
displacement correction or land masking is applied; nearby AIS is not a confirmed
identity, and an unmatched box is not proof of a dark vessel. Model class labels
are displayed as predictions, independently of actual AIS availability.

For the supplied Aarhus Bay scene (7 November 2026 05:32:04 UTC), the first run
processed 90 tiles: 35 raw boxes, 28 after deduplication, 37 AIS ships and 3 proximity
associations at 10% confidence. At the default 25% display threshold, 9 boxes remain
and none have an AIS association. The highest confidence was 37.6%.

| File | What |
|---|---|
| `pipeline/scenes.py` | Searches and downloads scenes, and the earlier images of the same orbit |
| `pipeline/detect.py` | Warps the scene to the grid the model was trained on, slides a 2048 px window over it, runs the detector and the attribute model (length, heading, speed), stores detections and cut-outs |
| `pipeline/model.py` | The model definitions, trimmed from the Ai2 repository |
| `pipeline/dma.py` | Loads Danish archive AIS around a pass |
| `pipeline/ais_recorder.py` | Records live AIS for the Dutch coast (needs `AISSTREAM_API_KEY` in `.env`) |
| `pipeline/infrastructure.py` | Downloads wind farms, platforms, pipelines and cables into one GeoJSON file |
| `pipeline/match.py` | Places every AIS ship at the second it was imaged and pairs ships with detections |
| `server/main.py` | FastAPI over `data/monitor.sqlite` |
| `web/` | React + Vite + TypeScript, shadcn/ui, MapLibre + deck.gl |

Three things make the matching accurate:

- **Earlier images.** The detector also sees the two previous images of the same place, so wind
  turbines and platforms (visible every time) are not reported as ships.
- **Moving ships appear shifted.** A ship moving towards or away from the radar shows up displaced
  along the satellite's track, by up to several hundred metres. The matcher predicts that shift
  from the ship's AIS speed and course.
- **Sea height.** The images are referenced to a surface about 40 m below the real sea level here,
  which moves everything afloat about 50 m towards the satellite. The matcher corrects for it.

## Limits

- A dark candidate is not proof: small boats often do not have to carry AIS, and shore-based AIS
  reception fades far offshore.
- Ships alongside a quay are usually not detected, so harbours show many "AIS only" ships.
- Detections keep their apparent radar position, which for a moving ship is not its true position.
- The infrastructure overlay includes planned wind farms, and cable routes from OpenStreetMap are
  not complete or survey-grade.
