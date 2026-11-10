import { useEffect, useMemo, useRef } from 'react'
import { Map, NavigationControl, ScaleControl, useControl, type MapRef } from 'react-map-gl/maplibre'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { PickingInfo } from '@deck.gl/core'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../maplibre-setup'

import type { LiveDetection, LiveTile } from '@/api'

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const MATCHED = [42, 120, 214] as const
const POTENTIAL_DARK = [235, 104, 52] as const
const UNKNOWN = [119, 119, 119] as const

interface AISPoint {
  detection: LiveDetection
  position: [number, number]
}

interface AISLink {
  path: [number, number][]
}

interface Props {
  tiles: LiveTile[]
  detections: LiveDetection[]
  selectedId: string | null
  onSelectDetection: (id: string) => void
}

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}

function color(detection: LiveDetection): [number, number, number] {
  if (detection.ais_status === 'matched') return [...MATCHED]
  if (detection.ais_status === 'potential_dark') return [...POTENTIAL_DARK]
  return [...UNKNOWN]
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[char]
  })
}

export function LiveMap({ tiles, detections, selectedId, onSelectDetection }: Props) {
  const mapRef = useRef<MapRef>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!map || !tiles.length) return
    const points = tiles.flatMap((tile) => tile.corners)
    map.fitBounds(
      [
        [Math.min(...points.map(([lon]) => lon)), Math.min(...points.map(([, lat]) => lat))],
        [Math.max(...points.map(([lon]) => lon)), Math.max(...points.map(([, lat]) => lat))],
      ],
      { padding: 48, duration: 800 },
    )
  }, [tiles])

  const aisPoints = useMemo(
    (): AISPoint[] =>
      detections.flatMap((detection) =>
        detection.ais ? [{ detection, position: [detection.ais.lon, detection.ais.lat] }] : [],
      ),
    [detections],
  )
  const aisLinks = useMemo(
    (): AISLink[] =>
      detections.flatMap((detection) =>
        detection.ais
          ? [{ path: [[detection.lon, detection.lat], [detection.ais.lon, detection.ais.lat]] }]
          : [],
      ),
    [detections],
  )

  const layers = [
    new PolygonLayer<LiveTile>({
      id: 'live-tiles',
      data: tiles,
      getPolygon: (tile) => tile.corners,
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (tile) => (detections.some((d) => d.tile_id === tile.tile_id) ? 1.5 : 0.8),
      getLineColor: (tile) => (detections.some((d) => d.tile_id === tile.tile_id) ? [70, 70, 70, 170] : [80, 80, 80, 90]),
      getFillColor: [100, 100, 100, 12],
      autoHighlight: true,
      highlightColor: [20, 20, 20, 45],
    }),
    new PathLayer<AISLink>({
      id: 'ais-links',
      data: aisLinks,
      getPath: (link) => link.path,
      getColor: [42, 120, 214, 175],
      getWidth: 1.5,
      widthUnits: 'pixels',
      pickable: false,
    }),
    new ScatterplotLayer<AISPoint>({
      id: 'ais-positions',
      data: aisPoints,
      getPosition: (point) => point.position,
      getRadius: 100,
      radiusUnits: 'meters',
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      filled: false,
      stroked: true,
      getLineColor: [...MATCHED, 240],
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      pickable: true,
      autoHighlight: true,
      highlightColor: [20, 20, 20, 220],
    }),
    new ScatterplotLayer<LiveDetection>({
      id: 'live-detections',
      data: detections,
      getPosition: (detection) => [detection.lon, detection.lat],
      getRadius: (detection) => (detection.id === selectedId ? 170 : 120),
      radiusUnits: 'meters',
      radiusMinPixels: 5,
      radiusMaxPixels: 18,
      getFillColor: (detection) => [...color(detection), 235],
      stroked: true,
      getLineColor: [255, 255, 255, 245],
      lineWidthUnits: 'pixels',
      getLineWidth: (detection) => (detection.id === selectedId ? 2.5 : 1.5),
      pickable: true,
      autoHighlight: true,
      highlightColor: [15, 15, 15, 220],
      updateTriggers: { getRadius: selectedId, getLineWidth: selectedId },
    }),
  ]

  const getTooltip = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return null
    if (layer.id === 'live-detections') {
      const detection = object as LiveDetection
      const status = detection.ais_status.replace('_', ' ')
      return {
        html: `<div class="mb-1 font-medium">${escapeHtml(status)}</div>
          <div class="flex justify-between gap-4 text-muted-foreground"><span>Confidence</span><span class="font-mono font-medium text-foreground">${(detection.conf * 100).toFixed(1)}%</span></div>
          <div class="flex justify-between gap-4 text-muted-foreground"><span>Position</span><span class="font-mono font-medium text-foreground">${detection.lat.toFixed(5)}, ${detection.lon.toFixed(5)}</span></div>
          <div class="mt-1 text-xs text-muted-foreground">Click to view vessel details</div>`,
        className: 'min-w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    }
    if (layer.id === 'ais-positions') {
      const point = object as AISPoint
      return {
        html: `<div class="mb-1 font-medium">AIS position</div>
          <div class="flex justify-between gap-4 text-muted-foreground"><span>Vessel</span><span class="font-medium text-foreground">${escapeHtml(point.detection.ais?.name || 'Unnamed')}</span></div>
          <div class="flex justify-between gap-4 text-muted-foreground"><span>MMSI</span><span class="font-mono font-medium text-foreground">${point.detection.ais?.mmsi}</span></div>
          <div class="mt-1 text-xs text-muted-foreground">Click to view matched detection</div>`,
        className: 'min-w-44 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
        style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
      }
    }
    const tile = object as LiveTile
    return {
      html: `<div class="font-medium">Sentinel-1 tile ${tile.tile_row}·${tile.tile_col}</div>`,
      className: 'rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-xl',
      style: { backgroundColor: 'var(--background)', color: 'var(--foreground)', padding: '6px 10px' },
    }
  }

  const onClick = ({ object, layer }: PickingInfo) => {
    if (!object || !layer) return
    if (layer.id === 'live-detections') onSelectDetection((object as LiveDetection).id)
    if (layer.id === 'ais-positions') onSelectDetection((object as AISPoint).detection.id)
  }

  return (
    <Map
      ref={mapRef}
      initialViewState={{ longitude: 10.2, latitude: 56.3, zoom: 7 }}
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
