import { useMemo } from 'react'
import { Map, NavigationControl, ScaleControl, useControl } from 'react-map-gl/maplibre'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'
import type { PickingInfo } from '@deck.gl/core'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@/maplibre-setup'

import type { Detection, GfwEvent, PresenceCell } from '@/api'
import { COLORS, fmtDateTime, fmtPass, rgb, titleCase } from '@/theme'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const NORTH_SEA: [number, number, number, number] = [-4, 50.5, 10.5, 62]

export interface Layers {
  dark: boolean
  ais: boolean
  heatmap: boolean
  density: boolean
  fishing: boolean
  loitering: boolean
}

export type Selection = { kind: 'detection'; item: Detection } | { kind: 'event'; item: GfwEvent }

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}

interface Props {
  detections: Detection[]
  events: GfwEvent[]
  presence: PresenceCell[]
  layers: Layers
  onSelect: (s: Selection) => void
}

const row = (k: string, v: string) =>
  `<div class="flex justify-between gap-6"><span class="text-muted-foreground">${k}</span><span class="font-medium tabular-nums">${v}</span></div>`

export function MonitorMap({ detections, events, presence, layers, onSelect }: Props) {
  const dark = useMemo(() => detections.filter((d) => !d.matched), [detections])
  const ais = useMemo(() => detections.filter((d) => d.matched), [detections])
  const fishing = useMemo(() => events.filter((e) => e.type === 'fishing'), [events])
  const loitering = useMemo(() => events.filter((e) => e.type === 'loitering'), [events])
  const maxHours = useMemo(() => Math.max(1, ...presence.map((p) => p.hours)), [presence])

  const all = [
    layers.density &&
      new PolygonLayer<PresenceCell>({
        id: 'density',
        data: presence,
        getPolygon: (p) => [
          [p.lon, p.lat],
          [p.lon + 0.1, p.lat],
          [p.lon + 0.1, p.lat + 0.1],
          [p.lon, p.lat + 0.1],
        ],
        stroked: false,
        // log scale: shipping lanes stand out without hiding the rest
        getFillColor: (p) => [90, 90, 90, Math.round(6 + 70 * (Math.log1p(p.hours) / Math.log1p(maxHours)))],
        updateTriggers: { getFillColor: maxHours },
      }),
    layers.heatmap &&
      layers.dark &&
      new HeatmapLayer<Detection>({
        id: 'dark-heatmap',
        data: dark,
        getPosition: (d) => [d.lon, d.lat],
        getWeight: (d) => d.n,
        radiusPixels: 28,
        intensity: 1.2,
        threshold: 0.04,
        colorRange: [
          [253, 224, 204],
          [250, 190, 155],
          [245, 150, 105],
          [235, 104, 52],
          [200, 75, 25],
          [150, 50, 15],
        ],
      }),
    layers.ais &&
      new ScatterplotLayer<Detection>({
        id: 'ais',
        data: ais,
        getPosition: (d) => [d.lon, d.lat],
        getFillColor: rgb(COLORS.ais, 150),
        radiusUnits: 'meters',
        getRadius: 500,
        radiusMinPixels: 1.6,
        radiusMaxPixels: 6,
        pickable: true,
        autoHighlight: true,
        highlightColor: [10, 10, 10, 220],
      }),
    layers.dark &&
      !layers.heatmap &&
      new ScatterplotLayer<Detection>({
        id: 'dark',
        data: dark,
        getPosition: (d) => [d.lon, d.lat],
        getFillColor: rgb(COLORS.dark, 210),
        radiusUnits: 'meters',
        getRadius: 600,
        radiusMinPixels: 2,
        radiusMaxPixels: 7,
        pickable: true,
        autoHighlight: true,
        highlightColor: [10, 10, 10, 220],
      }),
    ...(['fishing', 'loitering'] as const).map(
      (t) =>
        layers[t] &&
        new ScatterplotLayer<GfwEvent>({
          id: t,
          data: t === 'fishing' ? fishing : loitering,
          getPosition: (e) => [e.lon, e.lat],
          filled: false,
          stroked: true,
          getLineColor: rgb(COLORS[t], 220),
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          radiusUnits: 'pixels',
          getRadius: 5,
          pickable: true,
          autoHighlight: true,
          highlightColor: [10, 10, 10, 220],
        }),
    ),
  ].filter(Boolean)

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null
    let html: string
    if (layer.id === 'dark' || layer.id === 'ais') {
      const d = object as Detection
      html = `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block size-2.5 rounded-full" style="background:${d.matched ? COLORS.ais : COLORS.dark}"></span>${d.matched ? 'Radar detection, matched to AIS' : 'Dark vessel: no AIS match'}</div>
        ${row('Pass', fmtPass(d.ts))}${row('Waters', d.eez)}`
    } else {
      const e = object as GfwEvent
      html = `<div class="mb-1 flex items-center gap-2 font-medium"><span class="inline-block size-2.5 rounded-full border-2" style="border-color:${COLORS[e.type]}"></span>${e.type === 'fishing' ? 'Fishing' : 'Loitering'}: ${e.vessel_name ?? 'unknown vessel'}</div>
        ${row('Flag', e.flag ?? '–')}${row('Type', titleCase(e.vessel_type))}${row('Start', fmtDateTime(e.start))}`
    }
    return {
      html: `${html}<div class="mt-1.5 text-xs text-muted-foreground">Click for details</div>`,
      className: 'min-w-56 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
      style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
    }
  }

  const onClick = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return
    if (layer.id === 'dark' || layer.id === 'ais') onSelect({ kind: 'detection', item: object as Detection })
    else onSelect({ kind: 'event', item: object as GfwEvent })
  }

  return (
    <Map
      initialViewState={{ bounds: NORTH_SEA, fitBoundsOptions: { padding: 24 } }}
      mapStyle={BASEMAP}
      style={{ width: '100%', height: '100%' }}
      attributionControl={{ compact: true, customAttribution: 'Vessel data © Global Fishing Watch' }}
    >
      <DeckOverlay layers={all} getTooltip={getTooltip} onClick={onClick} />
      <NavigationControl position="top-right" />
      <ScaleControl position="bottom-left" />
    </Map>
  )
}
