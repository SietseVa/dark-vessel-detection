import { useEffect, useMemo, useState } from 'react'
import type { AisShip, Detection, Infrastructure, Scene } from '@/api'
import { loadAis, loadDetections, loadInfrastructure, loadScenes } from '@/api'
import { COLORS, fmt, fmtDateTime, INFRA, num, pct, REGION_NAMES } from '@/theme'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SceneMap, type Layers, type Selection } from '@/components/SceneMap'
import { DetailSheet } from '@/components/DetailSheet'

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />
}
function Ring({ color }: { color: string }) {
  return (
    <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full border-2" style={{ borderColor: color }} />
  )
}

const LAYER_ROWS: { key: keyof Layers; label: string; swatch: React.ReactNode }[] = [
  { key: 'dark', label: 'Radar detections without AIS', swatch: <Dot color={COLORS.dark} /> },
  { key: 'matched', label: 'Radar detections matched to AIS', swatch: <Dot color={COLORS.matched} /> },
  { key: 'aisMatched', label: 'AIS positions of matched ships', swatch: <Ring color={COLORS.matched} /> },
  { key: 'aisOnly', label: 'AIS ships not detected on radar', swatch: <Ring color={COLORS.aisOnly} /> },
  { key: 'radar', label: 'Radar image', swatch: <span className="size-2.5 shrink-0 rounded-sm bg-neutral-500" /> },
  { key: 'infrastructure', label: 'Offshore infrastructure', swatch: <span className="size-2.5 shrink-0" /> },
]

function Kpi({ label, value, sub, swatch }: { label: string; value: string; sub?: string; swatch?: React.ReactNode }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 text-xs">
          {swatch}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {sub && <CardDescription className="text-xs">{sub}</CardDescription>}
      </CardHeader>
    </Card>
  )
}

const sceneLabel = (s: Scene) => `${fmtDateTime(s.start_ts)} · ${REGION_NAMES[s.region] ?? s.region}`

export default function App() {
  const [scenes, setScenes] = useState<Scene[] | null>(null)
  const [sceneId, setSceneId] = useState<string | null>(null)
  const [detections, setDetections] = useState<Detection[]>([])
  const [ships, setShips] = useState<AisShip[]>([])
  const [error, setError] = useState<string | null>(null)
  const [minScore, setMinScore] = useState(90)
  const [minLength, setMinLength] = useState(0)
  const [layers, setLayers] = useState<Layers>({
    radar: true,
    dark: true,
    matched: true,
    aisMatched: true,
    aisOnly: true,
    infrastructure: true,
  })
  const [infrastructure, setInfrastructure] = useState<Infrastructure | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)

  useEffect(() => {
    loadScenes().then(
      (s) => {
        setScenes(s)
        setSceneId(s[0]?.id ?? null)
      },
      (e) => setError(String(e.message ?? e)),
    )
  }, [])

  useEffect(() => {
    loadInfrastructure().then(setInfrastructure, () => {}) // the map works without it
  }, [])

  useEffect(() => {
    if (!sceneId) return
    let live = true
    setSelection(null)
    Promise.all([loadDetections(sceneId), loadAis(sceneId)]).then(
      ([d, a]) => {
        if (!live) return
        setDetections(d)
        setShips(a)
      },
      (e) => live && setError(String(e.message ?? e)),
    )
    return () => {
      live = false
    }
  }, [sceneId])

  const scene = scenes?.find((s) => s.id === sceneId) ?? null

  // Filters apply to dark candidates only: a matched detection is confirmed by AIS whatever its score.
  const shown = useMemo(
    () => detections.filter((d) => d.mmsi != null || (d.score * 100 >= minScore && (d.length_m ?? 0) >= minLength)),
    [detections, minScore, minLength],
  )
  const dark = useMemo(
    () => shown.filter((d) => d.mmsi == null).sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)),
    [shown],
  )
  const matched = shown.length - dark.length
  const aisOnly = useMemo(
    () => ships.filter((s) => s.detection_id == null).sort((a, b) => (b.length_m ?? 0) - (a.length_m ?? 0)),
    [ships],
  )

  if (error)
    return (
      <div className="grid h-svh place-content-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold">Could not load data</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-sm text-muted-foreground">Is the API running on port 8020?</p>
      </div>
    )
  if (!scenes) return <div className="grid h-svh place-content-center text-muted-foreground">Loading scenes…</div>
  if (!scene)
    return (
      <div className="grid h-svh place-content-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold">No scenes yet</h1>
        <p className="text-sm text-muted-foreground">
          Run detection and matching first:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">uv run python -m pipeline.detect</code>
        </p>
      </div>
    )

  return (
    <div className="grid h-full grid-cols-1 overflow-hidden md:grid-cols-[420px_1fr]">
      <aside className="hidden min-h-0 border-r bg-sidebar md:block">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-6 p-5">
            <header className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Dark Vessel Monitor</h1>
              <p className="text-xs text-muted-foreground">
                Ships found by a detection model on Sentinel-1 radar images, compared with the ships that were
                broadcasting AIS at the same moment.
              </p>
            </header>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">Satellite pass</Label>
              <Select value={scene.id} onValueChange={setSceneId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scenes.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {sceneLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{scene.platform.replace('sentinel-', 'Sentinel-').toUpperCase().replace('SENTINEL', 'Sentinel')}</Badge>
                {scene.orbit_state && <Badge variant="outline">{scene.orbit_state} orbit</Badge>}
                {scene.detect_seconds != null && <Badge variant="outline">detection took {num(scene.detect_seconds / 60, 'min', 1)}</Badge>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Kpi label="Radar detections" value={fmt.format(shown.length)} sub="after the filters below" />
              <Kpi
                label="Matched to AIS"
                value={fmt.format(matched)}
                sub={`${pct(matched, shown.length)} of detections`}
                swatch={<Dot color={COLORS.matched} />}
              />
              <Kpi
                label="Dark candidates"
                value={fmt.format(dark.length)}
                sub="detected, no AIS nearby"
                swatch={<Dot color={COLORS.dark} />}
              />
              <Kpi
                label="AIS only"
                value={fmt.format(aisOnly.length)}
                sub={`of ${fmt.format(ships.length)} AIS ships in the image`}
                swatch={<Ring color={COLORS.aisOnly} />}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">Map layers</Label>
              <div className="flex flex-col gap-2.5">
                {LAYER_ROWS.map((l) => (
                  <div key={l.key} className="flex items-center gap-2.5">
                    <Checkbox
                      id={`layer-${l.key}`}
                      checked={layers[l.key]}
                      onCheckedChange={(v) => setLayers((s) => ({ ...s, [l.key]: v === true }))}
                    />
                    <Label htmlFor={`layer-${l.key}`} className="font-normal">
                      {l.swatch}
                      {l.label}
                    </Label>
                  </div>
                ))}
              </div>
              {layers.infrastructure && (
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 pl-6.5 text-xs text-muted-foreground">
                  {Object.entries(INFRA).map(([kind, v]) => (
                    <span key={kind} className="flex items-center gap-1.5">
                      <span aria-hidden className="inline-block h-0.5 w-3.5" style={{ background: v.color }} />
                      {v.label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <Label className="text-muted-foreground">Filter dark candidates</Label>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-sm">
                  <span>Model confidence at least</span>
                  <span className="font-medium tabular-nums">{minScore}%</span>
                </div>
                <Slider min={30} max={100} step={1} value={[minScore]} onValueChange={([v]) => setMinScore(v)} />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-sm">
                  <span>Estimated length at least</span>
                  <span className="font-medium tabular-nums">{minLength} m</span>
                </div>
                <Slider min={0} max={150} step={5} value={[minLength]} onValueChange={([v]) => setMinLength(v)} />
              </div>
            </div>

            <Separator />

            <Tabs defaultValue="dark">
              <TabsList className="w-full">
                <TabsTrigger value="dark">Dark candidates ({dark.length})</TabsTrigger>
                <TabsTrigger value="ais">AIS only ({aisOnly.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="dark">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Est. length</TableHead>
                      <TableHead>Est. speed</TableHead>
                      <TableHead className="text-right">Confidence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dark.slice(0, 200).map((d) => (
                      <TableRow
                        key={d.id}
                        className="cursor-pointer"
                        data-state={selection?.item === d ? 'selected' : undefined}
                        onClick={() => setSelection({ kind: 'detection', item: d })}
                      >
                        <TableCell className="tabular-nums">{num(d.length_m, 'm')}</TableCell>
                        <TableCell className="tabular-nums">{num(d.speed_kn, 'kn', 1)}</TableCell>
                        <TableCell className="text-right tabular-nums">{(d.score * 100).toFixed(1)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {dark.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">None with these filters.</p>}
              </TabsContent>
              <TabsContent value="ais">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ship</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Length</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aisOnly.slice(0, 200).map((s) => (
                      <TableRow
                        key={s.mmsi}
                        className="cursor-pointer"
                        data-state={selection?.item === s ? 'selected' : undefined}
                        onClick={() => setSelection({ kind: 'ship', item: s })}
                      >
                        <TableCell className="max-w-40 truncate">{s.name ?? s.mmsi}</TableCell>
                        <TableCell className="max-w-24 truncate text-muted-foreground">{s.ship_type ?? '–'}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(s.length_m, 'm')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {aisOnly.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Every AIS ship was detected.</p>}
              </TabsContent>
            </Tabs>

            <p className="text-xs leading-relaxed text-muted-foreground">
              A dark candidate is a radar detection with no AIS ship within reach at the moment of the pass. It is not
              proof of a ship hiding: small boats often do not have to carry AIS. The model compares each image with two
              earlier ones of the same place to leave out wind turbines and platforms. Infrastructure: EMODnet Human
              Activities and © OpenStreetMap contributors. Detection model: Ai2 Skylight (Apache 2.0). Radar: Copernicus Sentinel-1.
            </p>
          </div>
        </ScrollArea>
      </aside>

      <main className="relative min-h-0 min-w-0">
        <SceneMap
          key={scene.id}
          scene={scene}
          detections={shown}
          ships={ships}
          infrastructure={infrastructure}
          layers={layers}
          selection={selection}
          onSelect={setSelection}
        />
      </main>

      <DetailSheet selection={selection} ships={ships} onClose={() => setSelection(null)} />
    </div>
  )
}
