import { useState } from 'react'
import type { DetectionCounts, Tile } from '@/api'
import { tileThumbUrl } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CATEGORIES, MODEL_FILL } from '@/theme'
import { cn } from '@/lib/utils'
import { Swatch } from './Swatch'

const PAGE = 240

export function TileGrid({
  tiles,
  selected,
  onSelect,
  showLabels,
  detCounts,
}: {
  tiles: Tile[]
  selected: string | null
  onSelect: (id: string) => void
  /** Badge each tile with its labelled objects (off in model-only mode). */
  showLabels: boolean
  /** Badge each tile with its model detections; null when there are none to show. */
  detCounts: Map<string, DetectionCounts> | null
}) {
  const order = showLabels ? 'most dark vessels first' : 'most detected vessels first'
  // In Both mode either row of badges can be hidden.
  const both = showLabels && detCounts != null
  const [labelBadges, setLabelBadges] = useState(true)
  const [modelBadges, setModelBadges] = useState(true)
  const labelsOn = showLabels && (!both || labelBadges)
  const modelOn = detCounts != null && (!both || modelBadges)
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <p className="text-sm text-muted-foreground">
            {tiles.length > PAGE
              ? `Showing the first ${PAGE} of ${tiles.length} tiles, ${order}. Pick a scene to narrow down.`
              : `${tiles.length} tiles, ${order}`}
          </p>
          {both && (
            <div className="ml-auto flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Checkbox id="grid-labels" checked={labelBadges} onCheckedChange={(v) => setLabelBadges(v === true)} />
                <Label htmlFor="grid-labels">Labels</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="grid-model" checked={modelBadges} onCheckedChange={(v) => setModelBadges(v === true)} />
                <Label htmlFor="grid-model">Detections</Label>
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {tiles.slice(0, PAGE).map((t) => (
            <button
              key={t.tile_id}
              onClick={() => onSelect(t.tile_id)}
              title={t.tile_id}
              className={cn(
                'relative aspect-square overflow-hidden rounded-lg border bg-black outline-none transition hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring',
                t.tile_id === selected && 'ring-2 ring-primary',
              )}
            >
              <img
                src={tileThumbUrl(t.tile_id)}
                alt={`Tile ${t.tile_id}`}
                loading="lazy"
                className="size-full brightness-[1.6]"
              />
              <span className="absolute inset-x-1.5 bottom-1.5 flex flex-col items-start gap-1">
                {labelsOn && (
                  <span className="flex gap-1" title="Labels">
                    {CATEGORIES.map((c) =>
                      t.counts[c] ? (
                        <Badge key={c} variant="secondary" className="gap-1 px-1.5 tabular-nums">
                          <Swatch category={c} className="size-2" />
                          {t.counts[c]}
                        </Badge>
                      ) : null,
                    )}
                  </span>
                )}
                {modelOn && detCounts && (
                  <span className="flex gap-1" title="Detections">
                    {(['vessel', 'non_vessel'] as const).map((c) => {
                      const n = detCounts.get(t.tile_id)?.[c]
                      return n ? (
                        <Badge key={c} variant="outline" className="gap-1 bg-background/80 px-1.5 tabular-nums">
                          <span aria-hidden className="size-2 rounded-full" style={{ background: MODEL_FILL[c] }} />
                          {n}
                        </Badge>
                      ) : null
                    })}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}
