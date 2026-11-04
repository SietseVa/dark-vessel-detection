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
