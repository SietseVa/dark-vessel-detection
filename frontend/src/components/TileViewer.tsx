import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react'
import type { Detection, Tile, VesselObject } from '@/api'
import { loadTileDetections, tileImageUrl } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CATEGORIES, CATEGORY_HEX, CATEGORY_LABEL, CATEGORY_SHORT, MIN_CONF, MODEL_FILL, MODEL_HEX, MODEL_LABEL, MODEL_SHORT, type Layers } from '@/theme'
import { cn } from '@/lib/utils'
import { Swatch } from './Swatch'

type Channel = 'rgb' | 'vv' | 'vh'

interface Props {
  tile: Tile
  objects: VesselObject[]
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  /** Run name of the YOLO model, or null when no model is available. */
  model: string | null
  /** 'model' hides everything that comes from the dataset labels. */
  layers: Layers
}

export function TileViewer({ tile, objects, index, total, onPrev, onNext, onClose, model, layers }: Props) {
  const modelOnly = layers === 'model'
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState<{ id: string; im: HTMLImageElement } | null>(null)
  const img = loaded?.id === tile.tile_id ? loaded.im : null
  const [channel, setChannel] = useState<Channel>('rgb')
  const [gain, setGain] = useState(1)
  const [showBoxes, setShowBoxes] = useState(true)
  const [hovered, setHovered] = useState<number | null>(null)
  const [showModel, setShowModel] = useState(true)
  // Enlarged: the viewer fills the main area and the image grows to the available height.
  const [expanded, setExpanded] = useState(false)
  const [hoveredDet, setHoveredDet] = useState<string | null>(null)
  // Zoom and pan of the enlarged image, in screen pixels; tied to the tile so it resets on a new one.
  const [zoomState, setZoom] = useState({ id: '', k: 1, x: 0, y: 0 })
  const zoom = expanded && zoomState.id === tile.tile_id ? zoomState : { id: tile.tile_id, k: 1, x: 0, y: 0 }
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null)
  const [dets, setDets] = useState<{ id: string; dets: Detection[] | null; error?: string } | null>(null)
  const allDetections = dets?.id === tile.tile_id ? dets.dets : null
  const detError = dets?.id === tile.tile_id ? dets.error : undefined

  // Detections come from the prediction cache, or the backend runs the model on this tile now.
  useEffect(() => {
    if (!model) return
    let cancelled = false
    const id = tile.tile_id
    loadTileDetections(id).then(
      (d) => !cancelled && setDets({ id, dets: d }),
      (e) => !cancelled && setDets({ id, dets: null, error: String(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [tile.tile_id, model])

  const detections = (allDetections ?? []).filter((d) => d.conf >= MIN_CONF)
  // Object id -> class of the best detection matched to it.
  const found = new Map<number, Detection>()
  for (const d of detections) if (d.match_id != null && !found.has(d.match_id)) found.set(d.match_id, d)
  const unmatched = detections.filter((d) => d.match_id == null)

  // Hovering a table row highlights its boxes and dims the rest.
  const anyHot = hovered != null || hoveredDet != null
  const labelHot = (o: VesselObject) => hovered === o.id
  const detHot = (d: Detection) => hoveredDet === d.id || (d.match_id != null && hovered === d.match_id)

  // Wheel zoom around the cursor (enlarged only). Non-passive so the page does not scroll.
  useEffect(() => {
    const el = frameRef.current
    if (!el || !expanded) return
    const id = tile.tile_id
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setZoom((z) => {
        const cur = z.id === id ? z : { id, k: 1, x: 0, y: 0 }
        const k = Math.min(16, Math.max(1, cur.k * Math.exp(-e.deltaY * 0.002)))
        const f = k / cur.k
        return clampZoom({ id, k, x: px - (px - cur.x) * f, y: py - (py - cur.y) * f }, rect.width)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [expanded, tile.tile_id])

  useEffect(() => {
    let cancelled = false
    const id = tile.tile_id
    const im = new Image()
    im.onload = () => !cancelled && setLoaded({ id, im })
    im.src = tileImageUrl(id)
    return () => {
      cancelled = true
    }
  }, [tile.tile_id])

  // Radar tiles are mostly dark sea: stretch brightness and optionally isolate one polarisation.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, 640, 640)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      if (channel === 'rgb') {
        px[i] = Math.min(255, px[i] * gain)
        px[i + 1] = Math.min(255, px[i + 1] * gain)
        px[i + 2] = Math.min(255, px[i + 2] * gain)
      } else {
        const v = Math.min(255, (channel === 'vv' ? px[i] : px[i + 1]) * gain)
        px[i] = px[i + 1] = px[i + 2] = v
      }
    }
    ctx.putImageData(data, 0, 0)
  }, [img, channel, gain])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, [role="slider"], [role="combobox"]')) return
      if (e.key === 'Escape') {
        if (expanded) setExpanded(false)
        else onClose()
      }
      if (e.key === 'ArrowLeft') onPrev()
      if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext, expanded])

  return (
    <Card
      className={cn(
        'absolute z-10 gap-4 shadow-xl',
        expanded ? 'inset-3' : 'inset-y-3 right-3 w-[min(520px,calc(100%-1.5rem))]',
      )}
    >
      <CardHeader>
        <CardDescription className="text-xs uppercase tracking-wide">
          {tile.split} · scene {tile.scene_id.slice(0, 8)}
        </CardDescription>
        <CardTitle className="text-lg">
          Tile {tile.tile_row}·{tile.tile_col}
        </CardTitle>
        <CardAction className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={onPrev} aria-label="Previous tile" title="Previous (←)">
            <ChevronLeft />
          </Button>
          <span className="px-1 text-xs tabular-nums text-muted-foreground">
            {index + 1} / {total}
          </span>
          <Button variant="outline" size="icon-sm" onClick={onNext} aria-label="Next tile" title="Next (→)">
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Shrink' : 'Enlarge'}
            title={expanded ? 'Shrink (Esc)' : 'Enlarge (or click the image)'}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X />
          </Button>
        </CardAction>
      </CardHeader>

      {/* Options stay in view; only the part below them scrolls. */}
      <CardContent className="flex shrink-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={channel}
            onValueChange={(v) => v && setChannel(v as Channel)}
          >
            <ToggleGroupItem value="rgb">Composite</ToggleGroupItem>
            <ToggleGroupItem value="vv">VV</ToggleGroupItem>
            <ToggleGroupItem value="vh">VH</ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-center gap-3">
            <Label className="text-muted-foreground">Brightness</Label>
            <Slider className="w-28" min={1} max={10} step={0.5} value={[gain]} onValueChange={([v]) => setGain(v)} />
          </div>
          {/* Kept together so Labels always sits right in front of Model. */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Checkbox id="boxes" checked={showBoxes} onCheckedChange={(v) => setShowBoxes(v === true)} />
              <Label htmlFor="boxes">{modelOnly ? 'Detections' : 'Labels'}</Label>
            </div>
            {model && !modelOnly && (
              <div className="flex items-center gap-2">
                <Checkbox id="model-boxes" checked={showModel} onCheckedChange={(v) => setShowModel(v === true)} />
                <Label htmlFor="model-boxes">Detections</Label>
              </div>
            )}
          </div>
        </div>

        {(model || !modelOnly) && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
            {/* Labels: solid boxes by category. Model: dashed boxes by predicted class. */}
            {!modelOnly &&
              CATEGORIES.map((c) => (
                <span key={c} className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4" style={{ background: CATEGORY_HEX[c] }} /> {CATEGORY_LABEL[c]}
                  {model ? ' (label)' : ''}
                </span>
              ))}
            {model && (['vessel', 'non_vessel'] as const).map((c) => (
              <span key={c} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'h-0.5 w-4',
                    '[mask-image:repeating-linear-gradient(90deg,#000_0_4px,transparent_4px_7px)]',
                  )}
                  style={{ background: MODEL_FILL[c] }}
                />{' '}
                {MODEL_LABEL[c]}
              </span>
            ))}
          </div>
        )}

      </CardContent>

      <CardContent
        className={cn(
          'min-h-0 flex-1',
          expanded
            ? 'grid grid-rows-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_360px]'
            : 'flex flex-col gap-4 overflow-y-auto',
        )}
      >
        {/* Enlarged, the image is the largest square that fits its cell (container query units). */}
        <div className={cn('shrink-0', expanded && 'grid place-items-center')} style={expanded ? { containerType: 'size' } : undefined}>
        <div
          ref={frameRef}
          className={cn(
            'relative shrink-0 touch-none overflow-hidden rounded-lg bg-black select-none',
            expanded ? (zoom.k > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in') : 'aspect-square cursor-zoom-in',
          )}
          style={expanded ? { width: 'min(100cqw, 100cqh)', height: 'min(100cqw, 100cqh)' } : undefined}
          title={expanded ? undefined : 'Click to enlarge'}
          onPointerDown={(e) => {
            drag.current = { px: e.clientX, py: e.clientY, x: zoom.x, y: zoom.y, moved: false }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const dx = e.clientX - d.px
            const dy = e.clientY - d.py
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
            if (expanded && d.moved && zoom.k > 1) {
              const size = e.currentTarget.getBoundingClientRect().width
              setZoom(clampZoom({ id: tile.tile_id, k: zoom.k, x: d.x + dx, y: d.y + dy }, size))
            }
          }}
          onPointerUp={() => {
            if (drag.current && !drag.current.moved && !expanded) setExpanded(true)
            drag.current = null
          }}
          onDoubleClick={() => expanded && setZoom({ id: tile.tile_id, k: 1, x: 0, y: 0 })}
        >
          <div
            className="absolute inset-0 origin-top-left"
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})` }}
          >
          <canvas ref={canvasRef} width={640} height={640} className="absolute inset-0 size-full [image-rendering:pixelated]" />
          {!img && <div className="absolute inset-0 grid place-content-center text-sm text-muted-foreground">Loading…</div>}
          {showBoxes && !modelOnly && (
            <svg viewBox="0 0 640 640" className="pointer-events-none absolute inset-0 size-full">
              {objects.map((o) => {
                const pad = 4
                const w = Math.max(o.w_px, 10) + pad * 2
                const h = Math.max(o.h_px, 10) + pad * 2
                const hot = labelHot(o)
                return (
                  <rect
                    key={o.id}
                    x={o.x_px - w / 2}
                    y={o.y_px - h / 2}
                    width={w}
                    height={h}
                    rx={2}
                    fill={hot ? 'rgba(255,255,255,0.15)' : 'none'}
                    stroke={CATEGORY_HEX[o.category]}
                    strokeWidth={(hot ? 4 : 2) / zoom.k}
                    opacity={anyHot && !hot ? 0.3 : 1}
                  />
                )
              })}
            </svg>
          )}
          {model && (modelOnly ? showBoxes : showModel) && (
            <svg viewBox="0 0 640 640" className="pointer-events-none absolute inset-0 size-full">
              <defs>
                {/* Vessel boxes: left half AIS blue, right half dark orange. */}
                <linearGradient id="vessel-split">
                  <stop offset="50%" stopColor={CATEGORY_HEX.ais} />
                  <stop offset="50%" stopColor={CATEGORY_HEX.dark} />
                </linearGradient>
              </defs>
              {detections.map((d) => {
                const w = Math.max(d.w_px, 10)
                const h = Math.max(d.h_px, 10)
                // Colour by predicted class; always dashed so they never read as labels.
                const color = d.class === 'vessel' ? 'url(#vessel-split)' : MODEL_HEX.non_vessel
                const hot = detHot(d)
                return (
                  <rect
                    key={d.id}
                    x={d.x_px - w / 2}
                    y={d.y_px - h / 2}
                    width={w}
                    height={h}
                    fill={hot ? 'rgba(255,255,255,0.15)' : 'none'}
                    stroke={color}
                    strokeWidth={(hot ? 3.5 : 2) / zoom.k}
                    strokeDasharray={`${4 / zoom.k} ${3 / zoom.k}`}
                    opacity={anyHot && !hot ? 0.3 : 1}
                  />
                )
              })}
            </svg>
          )}
          </div>
          {expanded && (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
              {zoom.k > 1 ? `${zoom.k.toFixed(1)}× · drag to pan · double-click to reset` : 'Scroll to zoom'}
            </div>
          )}
        </div>
        </div>

        <div className={cn('flex flex-col gap-4', expanded && 'hidden min-h-0 overflow-y-auto lg:flex')}>
        {model && (
          <p className="text-xs text-muted-foreground">
            {detError ? (
              <>Model failed on this tile: {detError}</>
            ) : allDetections == null ? (
              <>Running {model}…</>
            ) : (
              <>
                {model}: {detections.length} detection{detections.length === 1 ? '' : 's'}
                {!modelOnly && objects.length > 0 && <> · found {found.size} of {objects.length} labels</>}
                {!modelOnly && unmatched.length > 0 && <> · {unmatched.length} without a label</>}
              </>
            )}
          </p>
        )}

        <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
          <span>{Math.round(tile.valid_fraction * 100)}% valid pixels</span>
          <span>
            {tile.center[1].toFixed(3)}°, {tile.center[0].toFixed(3)}°
          </span>
          <span>6.4 × 6.4 km</span>
        </div>

        {modelOnly ? (
          detections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {allDetections == null ? '' : 'The model detected nothing on this tile at this confidence.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Detected</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...detections]
                  .sort((a, b) => b.conf - a.conf)
                  .map((d) => (
                    <TableRow key={d.id} onMouseEnter={() => setHoveredDet(d.id)} onMouseLeave={() => setHoveredDet(null)}>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="inline-block size-2.5 shrink-0 rounded-full"
                            style={{ background: MODEL_FILL[d.class] }}
                          />
                          {MODEL_SHORT[d.class]}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{sizeM(d)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )
        ) : objects.length === 0 && !(model && unmatched.length) ? (
          <p className="text-sm text-muted-foreground">No labelled objects: empty sea tile.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                {model && <TableHead>Detected</TableHead>}
                <TableHead className="text-right">Length</TableHead>
                {model && <TableHead className="text-right">Size</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {objects.map((o) => (
                <TableRow key={o.id} onMouseEnter={() => setHovered(o.id)} onMouseLeave={() => setHovered(null)}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Swatch category={o.category} />
                      {CATEGORY_SHORT[o.category]}
                    </span>
                  </TableCell>
                  {model && (
                    <TableCell>
                      {allDetections == null ? (
                        '…'
                      ) : found.has(o.id) ? (
                        <ModelClass cls={found.get(o.id)!.class} />
                      ) : (
                        <span className="text-muted-foreground">missed</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {o.length_m != null ? `${o.length_m.toFixed(0)} m` : '–'}
                  </TableCell>
                  {model && (
                    <TableCell className="text-right tabular-nums">
                      {found.has(o.id) ? sizeM(found.get(o.id)!) : '–'}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {model &&
                unmatched.map((d) => (
                  <TableRow key={d.id} onMouseEnter={() => setHoveredDet(d.id)} onMouseLeave={() => setHoveredDet(null)}>
                    <TableCell className="text-muted-foreground">no label</TableCell>
                    <TableCell>
                      <ModelClass cls={d.class} />
                    </TableCell>
                    <TableCell className="text-right">–</TableCell>
                    <TableCell className="text-right tabular-nums">{sizeM(d)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
        </div>
      </CardContent>
    </Card>
  )
}

function ModelClass({ cls }: { cls: Detection['class'] }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: MODEL_FILL[cls] }} />
      {MODEL_SHORT[cls]}
    </span>
  )
}

/** Size of a detection box in metres (longest side; 10 m per pixel). */
const sizeM = (d: Detection) => `${Math.round(Math.max(d.w_px, d.h_px) * 10)} m`

/** Keep the zoomed image covering the frame (no empty edges while panning). */
function clampZoom<T extends { k: number; x: number; y: number }>(z: T, size: number): T {
  const min = size * (1 - z.k)
  return { ...z, x: Math.min(0, Math.max(min, z.x)), y: Math.min(0, Math.max(min, z.y)) }
}
