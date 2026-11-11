import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Map, NavigationControl, ScaleControl, Source, useControl, type MapRef } from 'react-map-gl/maplibre'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { BitmapLayer, GeoJsonLayer, LineLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { PickingInfo } from '@deck.gl/core'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@/maplibre-setup'

import { quicklookUrl, tilesUrl, type AisShip, type Detection, type InfraProps, type Infrastructure, type Scene } from '@/sar/api'
import { COLORS, INFRA, num, rgb } from '@/sar/theme'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

export interface Layers {
  radar: boolean
  dark: boolean
  matched: boolean
  aisMatched: boolean
  aisOnly: boolean
  infrastructure: boolean
}

export type Selection = { kind: 'detection'; item: Detection } | { kind: 'ship'; item: AisShip }

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}

interface Props {
  scene: Scene
  detections: Detection[]
  ships: AisShip[]
  infrastructure: Infrastructure | null
  layers: Layers
  selection: Selection | null
  onSelect: (s: Selection) => void
}

const row = (k: string, v: string) =>
  `<div class="flex justify-between gap-6"><span class="text-muted-foreground">${k}</span><span class="font-medium tabular-nums">${v}</span></div>`

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function SceneMap({ scene, detections, ships, infrastructure, layers, selection, onSelect }: Props) {
  const map = useRef<MapRef>(null)
  // Zoomed in, detection markers become outlines so the ship in the radar image stays visible.
  const [close, setClose] = useState(false)
  const dark = useMemo(() => detections.filter((d) => d.mmsi == null), [detections])
  const matched = useMemo(() => detections.filter((d) => d.mmsi != null), [detections])
  const shipsMatched = useMemo(() => ships.filter((s) => s.detection_id != null), [ships])
  const shipsOnly = useMemo(() => ships.filter((s) => s.detection_id == null), [ships])
  const byId = useMemo(() => new globalThis.Map(detections.map((d) => [d.id, d])), [detections])
  const links = useMemo(
    () => shipsMatched.filter((s) => byId.has(s.detection_id!)).map((s) => ({ ship: s, det: byId.get(s.detection_id!)! })),
    [shipsMatched, byId],
  )

  // Frame the scene when it changes, and fly to whatever gets selected.
  const bounds = useMemo((): [number, number, number, number] => {
    if (scene.quicklook) return [scene.quicklook.west, scene.quicklook.south, scene.quicklook.east, scene.quicklook.north]
    const lons = scene.footprint.map((p) => p[0])
    const lats = scene.footprint.map((p) => p[1])
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
  }, [scene])
  useEffect(() => {
    map.current?.fitBounds(bounds, { padding: 32, duration: 600 })
  }, [bounds])
  useEffect(() => {
    if (!selection) return
    const m = map.current
    if (!m) return
    m.flyTo({ center: [selection.item.lon, selection.item.lat], zoom: Math.max(m.getZoom(), 14), duration: 800 })
  }, [selection])

  const selected = selection ? [selection.item] : []

  const all = [
    // Fallback for scenes without full-resolution tiles: one coarse picture.
    layers.radar &&
      !scene.tiles &&
      scene.quicklook &&
      new BitmapLayer({
        id: 'radar',
        image: quicklookUrl(scene.id),
        bounds,
        opacity: 0.85,
      }),
    new PolygonLayer<Scene>({
      id: 'footprint',
      data: [scene],
      getPolygon: (s) => s.footprint,
      filled: false,
      getLineColor: [60, 60, 60, 160],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
    }),
    layers.infrastructure &&
      infrastructure &&
      new GeoJsonLayer<InfraProps>({
        id: 'infrastructure',
        data: infrastructure,
        stroked: true,
        filled: true,
        getFillColor: (f) => rgb(INFRA[f.properties.kind].color, f.geometry.type === 'Point' ? 255 : 40),
        getLineColor: (f) => rgb(INFRA[f.properties.kind].color, 230),
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        pointType: 'circle',
        pointRadiusUnits: 'pixels',
        getPointRadius: 3,
        pickable: true,
        autoHighlight: true,
        highlightColor: [10, 10, 10, 120],
      }),
    layers.aisMatched &&
      new LineLayer<{ ship: AisShip; det: Detection }>({
        id: 'links',
        data: links,
        getSourcePosition: (l) => [l.ship.lon, l.ship.lat],
        getTargetPosition: (l) => [l.det.lon, l.det.lat],
        getColor: rgb(COLORS.matched, 200),
        widthUnits: 'pixels',
        getWidth: 1.5,
      }),
    layers.matched &&
      new ScatterplotLayer<Detection>({
        id: 'matched',
        data: matched,
        getPosition: (d) => [d.lon, d.lat],
        getFillColor: rgb(COLORS.matched, close ? 0 : 220),
        stroked: close,
        getLineColor: rgb(COLORS.matched),
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        radiusUnits: 'pixels',
        getRadius: close ? 16 : 4,
        updateTriggers: { getFillColor: close, getRadius: close },
        pickable: true,
        autoHighlight: true,
        highlightColor: [10, 10, 10, 220],
      }),
    layers.dark &&
      new ScatterplotLayer<Detection>({
        id: 'dark',
        data: dark,
        getPosition: (d) => [d.lon, d.lat],
        getFillColor: rgb(COLORS.dark, close ? 0 : 235),
        stroked: true,
        getLineColor: close ? rgb(COLORS.dark) : [255, 255, 255, 230],
        lineWidthUnits: 'pixels',
        getLineWidth: close ? 2 : 1,
        radiusUnits: 'pixels',
        getRadius: close ? 16 : 4.5,
        updateTriggers: { getFillColor: close, getLineColor: close, getLineWidth: close, getRadius: close },
        pickable: true,
        autoHighlight: true,
        highlightColor: [10, 10, 10, 220],
      }),
    ...(
      [
        ['aisMatched', shipsMatched, COLORS.matched],
        ['aisOnly', shipsOnly, COLORS.aisOnly],
      ] as const
    ).map(
      ([id, data, color]) =>
        layers[id] &&
        new ScatterplotLayer<AisShip>({
          id,
          data: data as AisShip[],
          getPosition: (s) => [s.lon, s.lat],
          filled: false,
          stroked: true,
          getLineColor: rgb(color, 240),
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          radiusUnits: 'pixels',
          getRadius: 6,
          pickable: true,
          autoHighlight: true,
          highlightColor: [10, 10, 10, 220],
        }),
    ),
    new ScatterplotLayer<Detection | AisShip>({
      id: 'selected',
      data: selected,
      getPosition: (d) => [d.lon, d.lat],
      filled: false,
      stroked: true,
      getLineColor: [10, 10, 10, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 2.5,
      radiusUnits: 'pixels',
      getRadius: close ? 22 : 13,
      updateTriggers: { getRadius: close },
    }),
  ].filter(Boolean)

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null
    let html: string
    if (layer.id === 'dark' || layer.id === 'matched') {
      const d = object as Detection
      const isDark = d.mmsi == null
      html = `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block size-2.5 rounded-full" style="background:${isDark ? COLORS.dark : COLORS.matched}"></span>${isDark ? 'Radar detection, no AIS match' : 'Radar detection, matched to AIS'}</div>
        ${row('Confidence', `${(d.score * 100).toFixed(0)}%`)}${row('Estimated length', num(d.length_m, 'm'))}${isDark ? '' : row('Distance to AIS position', num(d.distance_m, 'm'))}${d.near ? row(`Nearest ${INFRA[d.near.kind].label.toLowerCase()}`, num(d.near.distance_m, 'm')) : ''}`
    } else if (layer.id === 'aisMatched' || layer.id === 'aisOnly') {
      const s = object as AisShip
      const color = s.detection_id ? COLORS.matched : COLORS.aisOnly
      html = `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block size-2.5 rounded-full border-2" style="border-color:${color}"></span>${escape(s.name ?? `MMSI ${s.mmsi}`)}</div>
        ${row('AIS', s.detection_id ? 'matched to a detection' : 'not detected on radar')}${row('Type', escape(s.ship_type ?? '–'))}${row('Length', num(s.length_m, 'm'))}${row('Speed', num(s.sog_kn, 'kn', 1))}`
    } else if (layer.id === 'infrastructure') {
      const p = (object as { properties: InfraProps }).properties
      const kind = INFRA[p.kind]
      html = `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block h-0.5 w-3" style="background:${kind.color}"></span>${kind.label}${p.name ? `: ${escape(p.name)}` : ''}</div>
        ${p.detail ? row('Details', escape(p.detail)) : ''}${p.status ? row('Status', escape(p.status)) : ''}`
      return {
        html,
        className: 'min-w-56 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    } else return null
    return {
      html: `${html}<div class="mt-1.5 text-xs text-muted-foreground">Click for details</div>`,
      className: 'min-w-56 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
      style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
    }
  }

  const onClick = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return
    if (layer.id === 'dark' || layer.id === 'matched') onSelect({ kind: 'detection', item: object as Detection })
    else if (layer.id === 'aisMatched' || layer.id === 'aisOnly') onSelect({ kind: 'ship', item: object as AisShip })
  }

  return (
    <Map
      ref={map}
      initialViewState={{ bounds, fitBoundsOptions: { padding: 32 } }}
      mapStyle={BASEMAP}
      onZoom={(e) => setClose(e.viewState.zoom >= 11.5)}
      style={{ width: '100%', height: '100%' }}
      attributionControl={{
        compact: true,
        customAttribution: 'Contains modified Copernicus Sentinel data · AIS: Danish Maritime Authority / aisstream.io',
      }}
    >
      {layers.radar && scene.tiles && (
        // Full-resolution radar image; at zoom 14 one tile pixel is one image pixel (about 5 m here).
        <Source id="radar" type="raster" tiles={[tilesUrl(scene.id)]} tileSize={256} minzoom={4} maxzoom={14} bounds={bounds}>
          <Layer id="radar" type="raster" paint={{ 'raster-opacity': 0.9, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 }} />
        </Source>
      )}
      <DeckOverlay layers={all} getTooltip={getTooltip} onClick={onClick} />
      <NavigationControl position="top-right" />
      <ScaleControl position="bottom-left" />
    </Map>
  )
}
