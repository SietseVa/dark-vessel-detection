import { useEffect, useMemo, useRef } from 'react'
import { Map, NavigationControl, ScaleControl, useControl, type MapRef } from 'react-map-gl/maplibre'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { PickingInfo } from '@deck.gl/core'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../maplibre-setup'

import type { Scene, Tile, VesselObject } from '@/api'
import { CATEGORY_HEX, CATEGORY_LABEL, hexToRgb } from '@/theme'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const WORLD_BOUNDS: [number, number, number, number] = [-26, 1, 19, 67]
const RGB = Object.fromEntries(Object.entries(CATEGORY_HEX).map(([k, v]) => [k, hexToRgb(v)])) as Record<
  VesselObject['category'],
  [number, number, number]
>
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
}

export function MapView({ scenes, tiles, objects, focusScene, selectedTile, onSelectTile }: Props) {
  const mapRef = useRef<MapRef>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const scene = scenes.find((s) => s.scene_id === focusScene)
    map.fitBounds(scene ? scene.bbox : WORLD_BOUNDS, { padding: 40, duration: 1200 })
  }, [focusScene, scenes])

  const sortedObjects = useMemo(() => [...objects].sort((a, b) => Z[a.category] - Z[b.category]), [objects])

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
      getFillColor: (t) =>
        t.tile_id === selectedTile ? [10, 10, 10, 30] : t.counts.dark > 0 ? [235, 104, 52, 28] : [80, 80, 80, 12],
      autoHighlight: true,
      highlightColor: [10, 10, 10, 30],
      updateTriggers: { getLineWidth: selectedTile, getLineColor: selectedTile, getFillColor: selectedTile },
    }),
    new ScatterplotLayer<VesselObject>({
      id: 'objects',
      data: sortedObjects,
      getPosition: (o) => [o.lon, o.lat],
      getFillColor: (o) => RGB[o.category],
      getRadius: (o) => Math.max(o.length_m ?? 0, 80),
      radiusUnits: 'meters',
      radiusMinPixels: 3,
      radiusMaxPixels: 14,
      stroked: true,
      getLineColor: [255, 255, 255, 230],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      pickable: true,
      autoHighlight: true,
      highlightColor: [10, 10, 10, 220],
    }),
  ]

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null
    if (layer.id === 'objects') {
      const o = object as VesselObject
      return {
        html: `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block size-2.5 rounded-full" style="background:${CATEGORY_HEX[o.category]}"></span>${CATEGORY_LABEL[o.category]}</div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Length</span><span class="font-mono font-medium text-foreground tabular-nums">${o.length_m != null ? o.length_m.toFixed(0) + ' m' : 'unknown'}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Fishing</span><span class="font-mono font-medium text-foreground tabular-nums">${o.is_fishing == null ? 'unknown' : o.is_fishing ? 'yes' : 'no'}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Label source</span><span class="font-mono font-medium text-foreground tabular-nums">${o.source}</span></div>
          <div class="flex justify-between gap-6 text-muted-foreground"><span>Shore distance</span><span class="font-mono font-medium text-foreground tabular-nums">${o.dist_shore_km != null ? o.dist_shore_km.toFixed(1) + ' km' : 'unknown'}</span></div>
          <div class="mt-1.5 text-xs text-muted-foreground">Click to open tile</div>`,
        className: 'min-w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    }
    const t = object as Tile
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
    onSelectTile(layer.id === 'objects' ? (object as VesselObject).tile_id : (object as Tile).tile_id)
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
