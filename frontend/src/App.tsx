import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Category, Dataset, Scene, VesselObject } from '@/api'
import { loadDataset } from '@/api'
import { DEFAULT_FILTERS, objectMatches, tileMatches, type Filters, type Fishing } from '@/filters'
import { CATEGORIES, CATEGORY_LABEL, fmt } from '@/theme'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MapView } from '@/components/MapView'
import { TileGrid } from '@/components/TileGrid'
import { TileViewer } from '@/components/TileViewer'
import { SceneBars, StackedHistogram, type BinDatum, type SceneDatum } from '@/components/Charts'
import { Swatch } from '@/components/Swatch'

const VESSELS: Category[] = ['ais', 'dark']
const ALL = '__all__'

function regionName([lon, lat]: [number, number]): string {
  if (lat > 63 && lon < -10) return 'Iceland'
  if (lat > 50) return 'North Sea'
  if (lat > 38 && lon > 11) return 'Adriatic'
  if (lat < 12 && lon > -5) return 'Gulf of Guinea'
  return 'Other'
}

const sceneLabel = (s: Scene) => `${regionName(s.center)} · ${s.scene_id.slice(0, 6)}`

function histogram(
  objects: VesselObject[],
  value: (o: VesselObject) => number | null,
  edges: number[],
  label: (lo: number, i: number) => string,
): BinDatum[] {
  const bins: BinDatum[] = edges.map((lo, i) => ({ label: label(lo, i), ais: 0, dark: 0 }))
  for (const o of objects) {
    if (o.category === 'fixed') continue
    const v = value(o)
    if (v == null) continue
    let i = edges.length - 1
    while (i > 0 && v < edges[i]) i--
    bins[i][o.category] = (bins[i][o.category] ?? 0) + 1
  }
  return bins
}

function Kpi({ label, value, sub, category }: { label: string; value: number; sub?: string; category?: Category }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 text-xs">
          {category && <Swatch category={category} className="size-2" />}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{fmt.format(value)}</CardTitle>
        {sub && <CardDescription className="text-xs">{sub}</CardDescription>}
      </CardHeader>
    </Card>
  )
}

export default function App() {
  const [data, setData] = useState<Dataset | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [view, setView] = useState<'map' | 'tiles'>('map')
  const [selectedTile, setSelectedTile] = useState<string | null>(null)

  useEffect(() => {
    loadDataset().then(setData, (e) => setError(String(e)))
  }, [])

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }))

  const scenes = useMemo(
    () =>
      (data?.scenes ?? [])
        .filter((s) => filters.split === 'all' || s.split === filters.split)
        .sort((a, b) => sceneLabel(a).localeCompare(sceneLabel(b))),
    [data, filters.split],
  )
  const objects = useMemo(() => (data?.objects ?? []).filter((o) => objectMatches(o, filters)), [data, filters])
  const tiles = useMemo(
    () =>
      (data?.tiles ?? [])
        .filter((t) => tileMatches(t, filters))
        .sort(
          (a, b) => b.counts.dark - a.counts.dark || b.counts.ais - a.counts.ais || a.tile_id.localeCompare(b.tile_id),
        ),
    [data, filters],
  )
  const objectsByTile = useMemo(() => {
    const m = new Map<string, VesselObject[]>()
    for (const o of data?.objects ?? []) {
      if (!m.has(o.tile_id)) m.set(o.tile_id, [])
      m.get(o.tile_id)!.push(o)
    }
    return m
  }, [data])

  const counts = useMemo(() => {
    const c: Record<Category, number> = { ais: 0, dark: 0, fixed: 0 }
    for (const o of objects) c[o.category]++
    return c
  }, [objects])

  // Ignores the scene filter so all scenes stay comparable while one is focused.
  const perScene = useMemo((): SceneDatum[] => {
    const noScene = { ...filters, scene: null }
    const by = new Map<string, Record<Category, number>>()
    for (const o of data?.objects ?? []) {
      if (!objectMatches(o, noScene)) continue
      if (!by.has(o.scene_id)) by.set(o.scene_id, { ais: 0, dark: 0, fixed: 0 })
      by.get(o.scene_id)![o.category]++
    }
    return scenes
      .map((s) => ({ label: sceneLabel(s), scene_id: s.scene_id, ...(by.get(s.scene_id) ?? { ais: 0, dark: 0, fixed: 0 }) }))
      .sort((a, b) => b.dark - a.dark)
  }, [data, filters, scenes])

  const lengthHist = useMemo(
    () =>
      histogram(objects, (o) => o.length_m, [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240], (lo, i) =>
        i === 12 ? '240+' : String(lo),
      ),
    [objects],
  )
  const shoreHist = useMemo(
    () => histogram(objects, (o) => o.dist_shore_km, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], (lo) => String(lo)),
    [objects],
  )

  const tileIndex = selectedTile ? tiles.findIndex((t) => t.tile_id === selectedTile) : -1
  const tile = selectedTile ? (data?.tiles.find((t) => t.tile_id === selectedTile) ?? null) : null
  const step = useCallback(
    (d: number) => {
      if (!tiles.length) return
      const i = tileIndex < 0 ? 0 : (tileIndex + d + tiles.length) % tiles.length
      setSelectedTile(tiles[i].tile_id)
    },
    [tiles, tileIndex],
  )

  if (error)
    return (
      <div className="grid h-svh place-content-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold">Could not load the dataset</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-sm text-muted-foreground">
          Is the backend running?{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            uv run uvicorn backend.main:app --reload --port 8000
          </code>
        </p>
      </div>
    )
  if (!data) return <div className="grid h-svh place-content-center text-muted-foreground">Loading dataset…</div>

  const vesselTotal = counts.ais + counts.dark
  const darkShare = vesselTotal ? Math.round((counts.dark / vesselTotal) * 100) : 0
  const activeScene = scenes.find((s) => s.scene_id === filters.scene)
  const vesselCats = VESSELS.filter((c) => filters.categories[c])
  const isDefault = JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS)

  return (
    <div className="grid h-svh grid-cols-1 overflow-hidden md:grid-cols-[380px_1fr]">
      <aside className="hidden min-h-0 border-r bg-sidebar md:block">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-6 p-5">
            <header>
              <h1 className="text-xl font-semibold tracking-tight">Dark Vessels</h1>
              <p className="text-xs text-muted-foreground">
                xView3-SAR training data · {data.summary.n_scenes} Sentinel-1 scenes ·{' '}
                {fmt.format(data.summary.n_tiles)} tiles
              </p>
            </header>

            <div className="grid grid-cols-3 gap-2">
              <Kpi label="Vessels" value={vesselTotal} />
              <Kpi label="Dark" value={counts.dark} sub={`${darkShare}% of vessels`} category="dark" />
              <Kpi label="Fixed" value={counts.fixed} category="fixed" />
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">Split</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  value={filters.split}
                  onValueChange={(v) => v && setFilters((f) => ({ ...f, split: v as Filters['split'], scene: null }))}
                >
                  <ToggleGroupItem value="all">All</ToggleGroupItem>
                  <ToggleGroupItem value="train">Train</ToggleGroupItem>
                  <ToggleGroupItem value="val">Validation</ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">Scene</Label>
                <Select value={filters.scene ?? ALL} onValueChange={(v) => set('scene', v === ALL ? null : v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All scenes ({scenes.length})</SelectItem>
                    {scenes.map((s) => (
                      <SelectItem key={s.scene_id} value={s.scene_id}>
                        {sceneLabel(s)} <span className="text-muted-foreground">({s.split})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">Show</Label>
                <div className="flex flex-col gap-2.5">
                  {CATEGORIES.map((c) => (
                    <div key={c} className="flex items-center gap-2.5">
                      <Checkbox
                        id={`cat-${c}`}
                        checked={filters.categories[c]}
                        onCheckedChange={(v) => set('categories', { ...filters.categories, [c]: v === true })}
                      />
                      <Label htmlFor={`cat-${c}`} className="flex-1 font-normal">
                        <Swatch category={c} />
                        {CATEGORY_LABEL[c]}
                      </Label>
                      <span className="text-sm tabular-nums text-muted-foreground">{fmt.format(counts[c])}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-muted-foreground">Fishing</Label>
                  <Select value={filters.fishing} onValueChange={(v) => set('fishing', v as Fishing)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="fishing">Fishing</SelectItem>
                      <SelectItem value="not_fishing">Not fishing</SelectItem>
                      <SelectItem value="unknown">Unknown</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-muted-foreground">Min. length: {filters.minLength} m</Label>
                  <Slider
                    className="h-9"
                    min={0}
                    max={200}
                    step={10}
                    value={[filters.minLength]}
                    onValueChange={([v]) => set('minLength', v)}
                  />
                </div>
              </div>
              {!isDefault && (
                <Button variant="link" className="h-auto self-start p-0" onClick={() => setFilters(DEFAULT_FILTERS)}>
                  Reset filters
                </Button>
              )}
            </div>

            <Separator />

            <Card size="sm">
              <CardHeader>
                <CardTitle>Objects per scene</CardTitle>
                <CardDescription>Sorted by dark vessels · click a bar to focus</CardDescription>
              </CardHeader>
              <CardContent>
                <SceneBars
                  data={perScene}
                  cats={CATEGORIES.filter((c) => filters.categories[c])}
                  active={filters.scene}
                  onSelect={(id) => set('scene', filters.scene === id ? null : id)}
                />
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>Vessel length (m)</CardTitle>
                <CardDescription>Vessels with a known length</CardDescription>
              </CardHeader>
              <CardContent>
                <StackedHistogram data={lengthHist} cats={vesselCats} />
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>Distance to shore (km)</CardTitle>
                <CardDescription>Only known within 10 km of shore; other vessels have no value.</CardDescription>
              </CardHeader>
              <CardContent>
                <StackedHistogram data={shoreHist} cats={vesselCats} />
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="flex items-center gap-4 border-b px-4 py-2">
          <Tabs value={view} onValueChange={(v) => setView(v as 'map' | 'tiles')}>
            <TabsList>
              <TabsTrigger value="map">Map</TabsTrigger>
              <TabsTrigger value="tiles">Tiles</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="truncate text-sm text-muted-foreground">
            {fmt.format(objects.length)} objects · {fmt.format(tiles.length)} tiles
            {activeScene ? ` · ${sceneLabel(activeScene)}` : ''}
          </span>
          {view === 'map' && (
            <span className="ml-auto hidden shrink-0 items-center gap-3 text-xs text-muted-foreground lg:flex">
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded-sm border border-neutral-500/60" /> train tile
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded-sm border border-[#7c5cd6]" /> validation tile
              </span>
            </span>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          {view === 'map' ? (
            <MapView
              scenes={data.scenes}
              tiles={tiles}
              objects={objects}
              focusScene={filters.scene}
              selectedTile={selectedTile}
              onSelectTile={setSelectedTile}
            />
          ) : (
            <TileGrid tiles={tiles} selected={selectedTile} onSelect={setSelectedTile} />
          )}
          {tile && (
            <TileViewer
              tile={tile}
              objects={objectsByTile.get(tile.tile_id) ?? []}
              index={Math.max(0, tileIndex)}
              total={tiles.length}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onClose={() => setSelectedTile(null)}
            />
          )}
        </div>
      </main>
    </div>
  )
}
