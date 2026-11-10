import { useEffect, useMemo, useRef } from 'react'
import { Map, NavigationControl, ScaleControl, useControl, type MapRef } from 'react-map-gl/maplibre'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { PickingInfo } from '@deck.gl/core'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../maplibre-setup'

import type { Detection, DetectionCounts, Scene, Tile, VesselObject } from '@/api'
import { CATEGORY_HEX, CATEGORY_LABEL, MODEL_HEX, MODEL_LABEL, hexToRgb, type Layers } from '@/theme'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const WORLD_BOUNDS: [number, number, number, number] = [-26, 1, 19, 67]
const RGB = Object.fromEntries(Object.entries(CATEGORY_HEX).map(([k, v]) => [k, hexToRgb(v)])) as Record<
  VesselObject['category'],
  [number, number, number]
>
const MODEL_RGB = {
  vessel: hexToRgb(MODEL_HEX.vessel),
  non_vessel: hexToRgb(MODEL_HEX.non_vessel),
}
// Draw order: fixed objects underneath, dark vessels on top.
const Z = { fixed: 0, ais: 1, dark: 2 }

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}

interface Props {
  scenes: Scene[]
  tiles: Tile[]
  objects: VesselObject[]
  focusScene: string | null
  selectedTile: string | null
  onSelectTile: (id: string) => void
  /** Object id -> confidence of the detection matched to it; null when no predictions are loaded. */
  foundConf: Map<number, number> | null
  predictedTiles: Set<string>
  /** Detections to draw: all of them in model-only mode, else only those without a label. */
  detections: Detection[]
  layers: Layers
  /** Detections per tile (above the threshold), for tile shading and tooltips in model-only mode. */
  detCounts: Map<string, DetectionCounts>
}

export function MapView({
  scenes,
  tiles,
  objects,
  focusScene,
  selectedTile,
  onSelectTile,
  foundConf,
  predictedTiles,
  detections,
  layers: mode,
  detCounts,
}: Props) {
  const modelOnly = mode === 'model'
  const mapRef = useRef<MapRef>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const scene = scenes.find((s) => s.scene_id === focusScene)
    map.fitBounds(scene ? scene.bbox : WORLD_BOUNDS, { padding: 40, duration: 1200 })
  }, [focusScene, scenes])

  const sortedObjects = useMemo(() => [...objects].sort((a, b) => Z[a.category] - Z[b.category]), [objects])

  // With predictions loaded, objects the model missed are drawn hollow.
  const missed = (o: VesselObject) => foundConf != null && predictedTiles.has(o.tile_id) && !foundConf.has(o.id)

  const layers = [
    new PolygonLayer<Tile>({
      id: 'tiles',
      data: tiles,
      getPolygon: (t) => t.corners,
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (t) => (t.tile_id === selectedTile ? 2.5 : 1),
      getLineColor: (t) =>
        t.tile_id === selectedTile ? [10, 10, 10, 255] : t.split === 'val' ? [124, 92, 214, 150] : [80, 80, 80, 90],
      getFillColor: (t) => {
        if (t.tile_id === selectedTile) return [10, 10, 10, 30]
        if (modelOnly) return detCounts.get(t.tile_id)?.vessel ? [...MODEL_RGB.vessel, 28] : [80, 80, 80, 12]
        return t.counts.dark > 0 ? [235, 104, 52, 28] : [80, 80, 80, 12]
      },
      autoHighlight: true,
      highlightColor: [10, 10, 10, 30],
      updateTriggers: {
        getLineWidth: selectedTile,
        getLineColor: selectedTile,
        getFillColor: [selectedTile, modelOnly, detCounts],
      },
    }),
    new ScatterplotLayer<VesselObject>({
      id: 'objects',
      data: sortedObjects,
      getPosition: (o) => [o.lon, o.lat],
      getFillColor: (o) => (missed(o) ? [255, 255, 255, 230] : RGB[o.category]),
      getRadius: (o) => Math.max(o.length_m ?? 0, 80),
      radiusUnits: 'meters',
      radiusMinPixels: 3,
      radiusMaxPixels: 14,
      stroked: true,
      getLineColor: (o) => (missed(o) ? RGB[o.category] : [255, 255, 255, 230]),
      lineWidthUnits: 'pixels',
      getLineWidth: (o) => (missed(o) ? 2 : 1),
      pickable: true,
      autoHighlight: true,
      highlightColor: [10, 10, 10, 220],
      updateTriggers: { getFillColor: [foundConf], getLineColor: [foundConf], getLineWidth: [foundConf] },
    }),
    new ScatterplotLayer<Detection>({
      id: 'detections',
      data: detections,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 120,
      radiusUnits: 'meters',
      radiusMinPixels: modelOnly ? 3 : 4,
      radiusMaxPixels: 12,
      // Model-only: solid dots by predicted class. Otherwise: dark rings for detections without a label.
      filled: modelOnly,
      getFillColor: (d) => MODEL_RGB[d.class],
      stroked: true,
      getLineColor: modelOnly ? [255, 255, 255, 230] : [30, 30, 30, 220],
      lineWidthUnits: 'pixels',
      getLineWidth: modelOnly ? 1 : 2,
      updateTriggers: { getLineColor: modelOnly, getLineWidth: modelOnly },
      pickable: true,
      autoHighlight: true,
      highlightColor: [10, 10, 10, 255],
    }),
  ]

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null
    if (layer.id === 'detections') {
      const d = object as Detection
      const title = modelOnly
        ? `<span class="inline-block size-2.5 rounded-full" style="background:${MODEL_HEX[d.class]}"></span>${MODEL_LABEL[d.class]}`
        : `<span class="inline-block size-2.5 rounded-full border-2 border-foreground"></span>Model detection, no label`
      const note = modelOnly ? 'Click to open tile' : 'False alarm, or a vessel the labels missed. Click to open tile'
      return {
        html: `<div class="mb-1 flex items-center gap-2 font-medium">${title}</div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Class</span><span class="font-mono font-medium text-foreground">${d.class}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Confidence</span><span class="font-mono font-medium text-foreground tabular-nums">${d.conf.toFixed(2)}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Position</span><span class="font-mono font-medium text-foreground tabular-nums">${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}</span></div>
          <div class="mt-1.5 text-xs text-muted-foreground">${note}</div>`,
        className: 'min-w-44 max-w-64 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    }
    if (layer.id === 'objects') {
      const o = object as VesselObject
      const model =
        foundConf == null || !predictedTiles.has(o.tile_id)
          ? ''
          : `<div class="flex justify-between gap-6 text-muted-foreground"><span>Model</span><span class="font-mono font-medium text-foreground tabular-nums">${foundConf.has(o.id) ? 'found ' + foundConf.get(o.id)!.toFixed(2) : 'missed'}</span></div>`
      return {
        html: `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block size-2.5 rounded-full" style="background:${CATEGORY_HEX[o.category]}"></span>${CATEGORY_LABEL[o.category]}</div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Length</span><span class="font-mono font-medium text-foreground tabular-nums">${o.length_m != null ? o.length_m.toFixed(0) + ' m' : 'unknown'}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Fishing</span><span class="font-mono font-medium text-foreground tabular-nums">${o.is_fishing == null ? 'unknown' : o.is_fishing ? 'yes' : 'no'}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Label source</span><span class="font-mono font-medium text-foreground tabular-nums">${o.source}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Shore distance</span><span class="font-mono font-medium text-foreground tabular-nums">${o.dist_shore_km != null ? o.dist_shore_km.toFixed(1) + ' km' : 'unknown'}</span></div>
          ${model}
          <div class="mt-1.5 text-xs text-muted-foreground">Click to open tile</div>`,
        className: 'min-w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    }
    const t = object as Tile
    if (modelOnly) {
      const c = detCounts.get(t.tile_id) ?? { vessel: 0, non_vessel: 0 }
      return {
        html: `<div class="mb-1 flex items-center gap-2 font-medium">Tile ${t.tile_row}·${t.tile_col} <span class="font-normal text-muted-foreground">${t.split}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Vessels detected</span><span class="font-mono font-medium text-foreground tabular-nums">${c.vessel}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Fixed objects detected</span><span class="font-mono font-medium text-foreground tabular-nums">${c.non_vessel}</span></div>
          <div class="mt-1.5 text-xs text-muted-foreground">Click to open tile</div>`,
        className: 'min-w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    }
    return {
      html: `<div class="mb-1 flex items-center gap-2 font-medium">Tile ${t.tile_row}·${t.tile_col} <span class="font-normal text-muted-foreground">${t.split}</span></div>
        <div class="flex justify-between gap-6 text-muted-foreground"><span>AIS vessels</span><span class="font-mono font-medium text-foreground tabular-nums">${t.counts.ais}</span></div>
        <div class="flex justify-between gap-6 text-muted-foreground"><span>Dark vessels</span><span class="font-mono font-medium text-foreground tabular-nums">${t.counts.dark}</span></div>
        <div class="flex justify-between gap-6 text-muted-foreground"><span>Fixed objects</span><span class="font-mono font-medium text-foreground tabular-nums">${t.counts.fixed}</span></div>
        <div class="mt-1.5 text-xs text-muted-foreground">Click to open tile</div>`,
      className: 'min-w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
      style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
    }
  }

  const onClick = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return
    onSelectTile((object as VesselObject | Detection | Tile).tile_id)
  }

  return (
    <Map
      ref={mapRef}
      initialViewState={{ bounds: WORLD_BOUNDS, fitBoundsOptions: { padding: 40 } }}
      mapStyle={BASEMAP}
      style={{ width: '100%', height: '100%' }}
      attributionControl={{ compact: true }}
    >
      <DeckOverlay layers={layers} getTooltip={getTooltip} onClick={onClick} />
      <NavigationControl position="top-right" />
      <ScaleControl position="bottom-left" />
    </Map>
  )
}
