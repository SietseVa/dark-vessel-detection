import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { Tile, VesselObject } from '@/api'
import { tileImageUrl } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CATEGORY_HEX, CATEGORY_SHORT } from '@/theme'
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
}

export function TileViewer({ tile, objects, index, total, onPrev, onNext, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState<{ id: string; im: HTMLImageElement } | null>(null)
  const img = loaded?.id === tile.tile_id ? loaded.im : null
  const [channel, setChannel] = useState<Channel>('rgb')
  const [gain, setGain] = useState(2)
  const [showBoxes, setShowBoxes] = useState(true)
  const [hovered, setHovered] = useState<number | null>(null)

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
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onPrev()
      if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  return (
    <Card className="absolute inset-y-3 right-3 z-10 w-[min(520px,calc(100%-1.5rem))] gap-4 overflow-y-auto shadow-xl">
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
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
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
          <div className="flex items-center gap-2">
            <Checkbox id="boxes" checked={showBoxes} onCheckedChange={(v) => setShowBoxes(v === true)} />
            <Label htmlFor="boxes">Boxes</Label>
          </div>
        </div>

        <div className="relative aspect-square shrink-0 overflow-hidden rounded-lg bg-black">
          <canvas ref={canvasRef} width={640} height={640} className="absolute inset-0 size-full [image-rendering:pixelated]" />
          {!img && <div className="absolute inset-0 grid place-content-center text-sm text-muted-foreground">Loading…</div>}
          {showBoxes && (
            <svg viewBox="0 0 640 640" className="absolute inset-0 size-full">
              {objects.map((o) => {
                const pad = 4
                const w = Math.max(o.w_px, 10) + pad * 2
                const h = Math.max(o.h_px, 10) + pad * 2
                return (
                  <rect
                    key={o.id}
                    x={o.x_px - w / 2}
                    y={o.y_px - h / 2}
                    width={w}
                    height={h}
                    rx={2}
                    fill="none"
                    stroke={CATEGORY_HEX[o.category]}
                    strokeWidth={hovered === o.id ? 3.5 : 2}
                  />
                )
              })}
            </svg>
          )}
        </div>

        <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
          <span>{Math.round(tile.valid_fraction * 100)}% valid pixels</span>
          <span>
            {tile.center[1].toFixed(3)}°, {tile.center[0].toFixed(3)}°
          </span>
          <span>6.4 × 6.4 km</span>
        </div>

        {objects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No labelled objects: empty sea tile.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Length</TableHead>
                <TableHead>Fishing</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Shore</TableHead>
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
                  <TableCell className="text-right tabular-nums">
                    {o.length_m != null ? `${o.length_m.toFixed(0)} m` : '–'}
                  </TableCell>
                  <TableCell>{o.is_fishing == null ? '–' : o.is_fishing ? 'yes' : 'no'}</TableCell>
                  <TableCell>{o.source}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {o.dist_shore_km != null ? `${o.dist_shore_km.toFixed(1)} km` : '–'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
