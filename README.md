# Dark Vessel Detection

In dit hackathonproject gaan we **dark vessels** opsporen op basis van satellietdata.

Een *dark vessel* is een schip dat wel op een satellietbeeld te zien is, maar geen signaal uitzendt via
het **Automatic Identification System (AIS)**. Grotere schepen sturen via AIS voortdurend hun positie,
naam en koers rond. Een schip dat zijn AIS uit heeft staan, is voor de meeste monitoringsystemen
onzichtbaar. Radarsatellieten zien zo'n schip wél: dag en nacht, en ook door wolken heen.

Het doel: schepen herkennen op radarbeelden van de Sentinel-1-satellieten, die detecties vergelijken met
AIS-gegevens, en zo zichtbaar maken welke schepen "dark" zijn.
---

## De dataset

Jullie hebben de data via de WeTransfer-link gedownload. De dataset is gebaseerd op
[xView3-SAR](https://iuu.xview.us): een openbare verzameling Sentinel-1-radarbeelden waarin schepen en
vaste objecten zijn gelabeld.

De originele xView3-data bestaat uit grote `.tif`-rasterbestanden. Die zijn alvast voorbewerkt:

- De rasterbestanden zijn opgeknipt in **tegels van 640 × 640 pixels** (`.png`). Eén pixel is 10 × 10 meter,
  één tegel dus 6,4 × 6,4 km.
- Elke tegel heeft drie kleurkanalen: **R = VV**, **G = VH** (de twee radarpolarisaties) en
  **B = het gemiddelde** van beide. Schepen zijn heldere stippen op een donkere zee.
- De labels staan in **YOLO-formaat**: per object één regel `class cx cy w h`, met waarden tussen 0 en 1.
  Een leeg labelbestand betekent een tegel zonder objecten.

```
xview3_tiles/
├── images/train/, images/val/     de tegels (.png)
├── labels/train/, labels/val/     de labels (.txt, YOLO-formaat)
├── data.yaml                      datasetconfiguratie voor YOLO
└── meta/
    ├── objects.csv                extra informatie per object (zie hieronder)
    ├── tiles.csv                  waar elke tegel in het oorspronkelijke beeld lag
    └── summary.json               alle instellingen van de voorbewerking
```

**Klassen**

| class | naam | wat |
|---|---|---|
| 0 | `vessel` | schip |
| 1 | `non_vessel` | vast object, zoals een windturbine of booreiland |

Train en validatie zijn **per satellietbeeld** gesplitst. Tegels uit hetzelfde beeld lijken sterk op
elkaar, dus zo blijft de validatiescore eerlijk.

**AIS in de trainingsset.** `meta/objects.csv` bevat per object onder meer de scheepslengte, of het een
vissersschip is, de positie (lat/lon) en de **bron van het label**:

- `ais` of `ais/manual`: het schip was via AIS bekend
- `manual`: het schip is door een analist gevonden **zonder** AIS-match. Dat is een dark vessel.

---

## Opbouw van het project

Het project bestaat uit vijf blokken, die op elkaar voortbouwen.

1. **Scheepsdetectie.** Train op de dataset een model dat schepen herkent op de `.png`-tegels,
   bijvoorbeeld met YOLO.
2. **Dashboard op de trainingsset.** Bouw een dashboard dat het model op de trainingsdata toepast en de
   detecties combineert met de AIS-informatie uit `meta/objects.csv`: welke schepen had het model
   gevonden, en welke daarvan hadden AIS?
3. **Pipeline voor nieuwe satellietbeelden.** Pas het model toe op recent gedownloade Sentinel-1-data.
4. **Pipeline voor AIS.** Haal bij elk gedownload Sentinel-1-beeld de AIS-gegevens van dezelfde plek en
   hetzelfde moment op.
5. **Alles samen.** Integreer de Sentinel-1- en AIS-pipelines in het dashboard, zodat het up-to-date blijft.

---

## Helper-notebooks

Voor blok 3 tot en met 5 staan er al drie notebooks klaar. Draai ze op volgorde.

| Notebook | Wat het doet |
|---|---|
| `sentinel_downloader.ipynb` | Downloadt Sentinel-1-beelden van [Copernicus](https://dataspace.copernicus.eu) voor de gebieden die in `.env` zijn gedefinieerd. De beelden worden opgeslagen als `.tif`-rasterbestanden (VV en VH, in dB, 10 m per pixel). |
| `tiff_to_tiles.ipynb` | Zet die `.tif`-bestanden om naar `.png`-tegels in precies hetzelfde formaat als de trainingsdata, en legt van elke tegel de positie op de kaart vast. |
| `match_ais_to_sentinel.ipynb` | Haalt bij [Global Fishing Watch](https://globalfishingwatch.org) de AIS-gegevens op rond elke gedownloade satellietpassage: welke schepen waren er, met naam, MMSI, vlag en positie. |

Elk notebook heeft bovenaan een cel **Settings** waarin je per run iets kunt aanpassen, bijvoorbeeld
één gebied of één datum. Opnieuw draaien vult de data alleen aan: wat al binnen is, wordt niet nog
eens gedownload.

Met de functie `tile_pixel_to_latlon` uit `tiff_to_tiles.ipynb` zet je de positie van een detectie
(een pixel in een tegel) om naar breedte- en lengtegraad. Zo kun je detecties vergelijken met AIS-posities.

---

## Dashboard (frontend + API)

Een webdashboard om de dataset te verkennen: een kaart met alle tegels en objecten (AIS, dark, vast),
een tegelbrowser met de labels over het radarbeeld, en grafieken per scène, lengte en afstand tot de kust.

- `backend/`: FastAPI. Leest `data/xview3_tiles/` en serveert de metadata en tegelbeelden onder `/api`.
  Tegels hebben in de dataset geen lat/lon; per scène wordt een kubische fit pixel → lat/lon gemaakt op de
  objecten (fout < 10 m) om elke tegel op de kaart te zetten.
- `frontend/`: React + Vite + TypeScript, shadcn/ui (Tailwind), MapLibre + deck.gl, Recharts.

### Dashboard starten

**Vereisten:** [uv](https://docs.astral.sh/uv/) en Node.js 20+. De dataset staat in `data/` of
`data/xview3_tiles/` (gitignored); een eigen pad kan met `DATA_DIR=...`.

1. **Haal de nieuwste versie van `main` op** (vanuit de root van de repo):

   ```bash
   git switch main
   git pull
   ```

   `data/` en `runs/` staan niet in git en blijven dus gewoon staan.

2. **Installeer de Python-pakketten** (FastAPI, Ultralytics, ...):

   ```bash
   uv sync
   ```

3. **Installeer Node.js** (eenmalig, voor de frontend):

   ```bash
   brew install node
   ```

   Liever niets installeren? Zet dan `uvx --from nodejs-wheel` vóór elk `npm`-commando, bijvoorbeeld
   `uvx --from nodejs-wheel npm install`.

4. **Start de app in twee terminals:**

   ```bash
   # terminal 1: de API
   uv run uvicorn backend.main:app --reload --port 8000

   # terminal 2: de frontend
   cd frontend && npm install && npm run dev
   ```

5. Open http://localhost:5180. De frontend stuurt `/api` door naar poort 8000.

Krijg je een foutmelding dat poort 8000 of 5180 al in gebruik is, dan draait de app nog ergens anders.
Stop die eerst.

### YOLO-model in het dashboard

De API laadt automatisch de nieuwste `runs/**/weights/best.pt` (of kies er zelf een met `MODEL_PATH=...`).
Zonder gewichten werkt het dashboard gewoon, alleen zonder modelresultaten.

- In de tegelviewer staan de detecties van het model gestippeld over het radarbeeld (wit = komt overeen
  met een label, geel = geen label), met een kolom *Model* in de objecttabel. Een tegel die nog niet
  voorspeld is, wordt bij openen door het model gehaald.
- Draai het model één keer over de hele dataset om ook de kaart en de scores in de zijbalk te vullen:

  ```bash
  uv run python -m backend.predict            # of --split val, --weights pad/naar/best.pt
  ```

  De resultaten komen in `data/cache/predictions/<run>.json`. Herstart daarna de API.
- Een detectie telt als gevonden binnen 200 m (20 px) van een label, net als bij xView3. Op de kaart zijn
  gemiste objecten hol, en detecties zonder label donkere ringen: vals alarm, of een schip dat niet gelabeld is.
- Het model is op de train-tegels getraind: kijk naar de **Validation**-split voor een eerlijke score.
- Met de knop **Labels / Model / Both** bovenaan kies je wat je ziet. *Model* toont alleen wat het model
  gedetecteerd heeft (roze = schip, groen = vast object), zonder de labels uit de dataset. *Both* toont de
  labels, gemarkeerd als gevonden of gemist.
- De betrouwbaarheidsdrempel start op de waarde met de beste F1 voor schepen op de validatieset; met de
  schuifregelaar pas je hem aan.

**Modelgewichten staan niet in git.** Zet een getraind model in `runs/<naam>/weights/best.pt` (bijvoorbeeld
via de gedeelde map van het team) en draai daarna `uv run python -m backend.predict`. Dat is alleen nodig
als je een nieuw model toevoegt: de resultaten worden bewaard in `data/cache/predictions/`.
