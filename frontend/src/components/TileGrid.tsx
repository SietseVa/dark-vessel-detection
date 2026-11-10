import type { DetectionCounts, Tile } from '@/api'
import { tileThumbUrl } from '@/api'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CATEGORIES, MODEL_HEX } from '@/theme'
import { cn } from '@/lib/utils'
import { Swatch } from './Swatch'

const PAGE = 240

export function TileGrid({
  tiles,
  selected,
  onSelect,
  detCounts,
}: {
  tiles: Tile[]
  selected: string | null
  onSelect: (id: string) => void
  /** Model-only mode: badge each tile with its detections instead of its labels. */
  detCounts: Map<string, DetectionCounts> | null
}) {
  const order = detCounts ? 'most detected vessels first' : 'most dark vessels first'
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <p className="mb-3 text-sm text-muted-foreground">
          {tiles.length > PAGE
            ? `Showing the first ${PAGE} of ${tiles.length} tiles, ${order}. Pick a scene to narrow down.`
            : `${tiles.length} tiles, ${order}`}
        </p>
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
              <span className="absolute bottom-1.5 left-1.5 flex gap-1">
                {detCounts
                  ? (['vessel', 'non_vessel'] as const).map((c) => {
                      const n = detCounts.get(t.tile_id)?.[c]
                      return n ? (
                        <Badge key={c} variant="secondary" className="gap-1 px-1.5 tabular-nums">
                          <span aria-hidden className="size-2 rounded-full" style={{ background: MODEL_HEX[c] }} />
                          {n}
                        </Badge>
                      ) : null
                    })
                  : CATEGORIES.map((c) =>
                  t.counts[c] ? (
                    <Badge key={c} variant="secondary" className="gap-1 px-1.5 tabular-nums">
                      <Swatch category={c} className="size-2" />
                      {t.counts[c]}
                    </Badge>
                  ) : null,
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}
