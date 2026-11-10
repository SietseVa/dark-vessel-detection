import type { Category, DetectionCounts, Tile } from '@/api'
import { tileThumbUrl } from '@/api'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CATEGORIES, MODEL_FILL } from '@/theme'
import { cn } from '@/lib/utils'
import { Swatch } from './Swatch'

const PAGE = 240

/** How the model did on one tile (Both mode). */
export interface TileScore {
  total: Record<Category, number>
  found: Record<Category, number>
}

export function TileGrid({
  tiles,
  selected,
  onSelect,
  showLabels,
  detCounts,
  scores,
}: {
  tiles: Tile[]
  selected: string | null
  onSelect: (id: string) => void
  /** Badge each tile with its labelled objects (off in model-only mode). */
  showLabels: boolean
  /** Badge each tile with its model detections; null when there are none to show. */
  detCounts: Map<string, DetectionCounts> | null
  /** Both mode: found/missed per tile; tiles missing from the map were not run through the model. */
  scores: Map<string, TileScore> | null
}) {
  const order = 'most labelled dark vessels first'
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <p className="text-sm text-muted-foreground">
            {tiles.length > PAGE
              ? `Showing the first ${PAGE} of ${tiles.length} tiles, ${order}. Pick a scene to narrow down.`
              : `${tiles.length} tiles, ${order}`}
          </p>
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
              {/* Badges stacked, one per line. Both mode: labels as found / total. */}
              <span className="absolute bottom-1.5 left-1.5 flex flex-col items-start gap-1">
                {showLabels
                  ? CATEGORIES.map((c) => {
                      const score = scores?.get(t.tile_id)
                      if (score) {
                        const found = score.found[c]
                        const total = score.total[c]
                        return total ? (
                          <Badge
                            key={c}
                            variant="secondary"
                            className="gap-1 px-1.5 tabular-nums"
                            title={`${found} of ${total} found and classified correctly`}
                          >
                            <Swatch category={c} className="size-2" />
                            {found}
                            <span className="text-muted-foreground">/{total}</span>
                          </Badge>
                        ) : null
                      }
                      return t.counts[c] ? (
                        <Badge key={c} variant="secondary" className="gap-1 px-1.5 tabular-nums">
                          <Swatch category={c} className="size-2" />
                          {t.counts[c]}
                        </Badge>
                      ) : null
                    })
                  : detCounts &&
                    (['vessel', 'non_vessel'] as const).map((c) => {
                      const n = detCounts.get(t.tile_id)?.[c]
                      return n ? (
                        <Badge key={c} variant="secondary" className="gap-1 px-1.5 tabular-nums">
                          <span aria-hidden className="size-2 rounded-full" style={{ background: MODEL_FILL[c] }} />
                          {n}
                        </Badge>
                      ) : null
                    })}
              </span>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}
