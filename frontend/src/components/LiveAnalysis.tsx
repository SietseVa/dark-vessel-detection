import { useEffect, useState } from 'react'
import { analyzeLiveScene, liveTileImageUrl, loadLiveScenes, loadLiveTiles, type LiveAnalysisResult, type LiveDetection, type LiveScene, type LiveTile } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LiveMap } from '@/components/LiveMap'

interface Props {
  modelAvailable: boolean
  modelName?: string
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

function statusLabel(status: LiveDetection['ais_status']): string {
  if (status === 'matched') return 'AIS matched'
  if (status === 'potential_dark') return 'Potential dark'
  return 'AIS coverage unknown'
}

function StatusBadge({ status }: { status: LiveDetection['ais_status'] }) {
  const variant = status === 'potential_dark' ? 'destructive' : status === 'matched' ? 'secondary' : 'outline'
  return <Badge variant={variant}>{statusLabel(status)}</Badge>
}

function sceneLabel(scene: LiveScene): string {
  const time = scene.acquired_utc ? new Date(scene.acquired_utc).toLocaleString() : scene.key
  return `${scene.area} · ${time}`
}

export function LiveAnalysis({ modelAvailable, modelName }: Props) {
  const [scenes, setScenes] = useState<LiveScene[]>([])
  const [sceneKey, setSceneKey] = useState('')
  const [tileSet, setTileSet] = useState<{ sceneKey: string; tiles: LiveTile[] }>({ sceneKey: '', tiles: [] })
  const [analysis, setAnalysis] = useState<LiveAnalysisResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingScenes, setLoadingScenes] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadLiveScenes().then(
      (items) => {
        setScenes(items)
        if (items.length) setSceneKey(items[0].key)
        setLoadingScenes(false)
      },
      (e) => {
        setError(String(e))
        setLoadingScenes(false)
      },
    )
  }, [])

  useEffect(() => {
    if (!sceneKey) return
    let active = true
    loadLiveTiles(sceneKey).then(
      (items) => {
        if (active) setTileSet({ sceneKey, tiles: items })
      },
      (e) => {
        if (active) setError(String(e))
      },
    )
    return () => {
      active = false
    }
  }, [sceneKey])

  const tiles = tileSet.sceneKey === sceneKey ? tileSet.tiles : []
  const scene = scenes.find((item) => item.key === sceneKey) ?? null
  const detections = analysis?.detections ?? []
  const selected = detections.find((detection) => detection.id === selectedId) ?? detections[0] ?? null
  const tileDetections = selected ? detections.filter((detection) => detection.tile_id === selected.tile_id) : []
  const matched = detections.filter((detection) => detection.ais_status === 'matched').length
  const potentialDark = detections.filter((detection) => detection.ais_status === 'potential_dark').length

  const runAnalysis = async () => {
    if (!sceneKey) return
    setRunning(true)
    setError(null)
    setAnalysis(null)
    setSelectedId(null)
    try {
      const result = await analyzeLiveScene(sceneKey)
      setAnalysis(result)
      setSelectedId(result.detections[0]?.id ?? null)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold tracking-tight">Live Sentinel-1 analysis</h1>
          <p className="text-sm text-muted-foreground">
            Run {modelName ?? 'the vessel model'} on a tiled scene and compare vessel detections with same-pass AIS.
          </p>
        </div>
        <div className="w-full sm:w-80">
          <Select
            value={sceneKey}
            onValueChange={(key) => {
              setSceneKey(key)
              setAnalysis(null)
              setSelectedId(null)
              setError(null)
            }}
            disabled={loadingScenes || running || scenes.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={loadingScenes ? 'Loading scenes…' : 'Select a Sentinel-1 scene'} />
            </SelectTrigger>
            <SelectContent>
              {scenes.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {sceneLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={runAnalysis} disabled={!sceneKey || !modelAvailable || running}>
          {running ? 'Running model…' : analysis ? 'Run again' : 'Run detection'}
        </Button>
      </div>

      {scene && (
        <p className="text-xs text-muted-foreground">
          {scene.tile_count} tiles · {scene.ais_count} AIS positions in the pass database ·{' '}
          {scene.ais_covered ? 'AIS coverage recorded' : 'AIS coverage unavailable'}
          {analysis && ` · detections use confidence ≥ ${analysis.min_conf.toFixed(2)} and a ${analysis.match_radius_m} m match radius`}
        </p>
      )}
      {!modelAvailable && (
        <p className="text-sm text-destructive">
          No model weights are available. Configure MODEL_PATH or add runs/detect/yolo26m-vessels-FINAL/weights/best.pt.
        </p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {!loadingScenes && scenes.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          No tiled Sentinel-1 scenes were found. Generate the scene tiles first; each scene needs scene.json, tiles.csv,
          tiles.json, and its tile PNGs.
        </p>
      )}
      {analysis && (
        <div className="grid grid-cols-3 gap-3">
          <Card size="sm">
            <CardHeader>
              <CardDescription>Vessel detections</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{number.format(detections.length)}</CardTitle>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>AIS matched</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{number.format(matched)}</CardTitle>
            </CardHeader>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardDescription>{analysis.ais_covered ? 'Potential dark' : 'AIS unknown'}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {number.format(analysis.ais_covered ? potentialDark : detections.length)}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {scene && tiles.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden xl:grid-cols-[minmax(0,1.7fr)_minmax(360px,1fr)]">
          <div className="relative min-h-[360px] overflow-hidden rounded-lg border">
            <LiveMap
              key={sceneKey}
              tiles={tiles}
              detections={detections}
              selectedId={selected?.id ?? null}
              onSelectDetection={setSelectedId}
            />
            <div className="absolute bottom-5 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-md border bg-background/95 px-3 py-2 text-xs shadow">
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#2a78d6]" /> AIS matched</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#eb6834]" /> Potential dark</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-neutral-500" /> AIS unknown</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-[#2a78d6]" /> AIS position</span>
            </div>
          </div>

          <Card className="flex min-h-0 flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>{selected ? 'Selected vessel' : 'Detected vessels'}</CardTitle>
              <CardDescription>
                {analysis
                  ? analysis.ais_covered
                    ? 'Unmatched detections are potential dark vessels, not confirmed violations.'
                    : 'AIS coverage is unknown, so unmatched detections are not labelled dark.'
                  : 'Run the model to plot vessel detections on the map.'}
              </CardDescription>
            </CardHeader>
            {selected && sceneKey && (
              <CardContent className="flex flex-col gap-3">
                <div className="grid grid-cols-[128px_1fr] gap-3">
                  <div className="relative aspect-square overflow-hidden rounded-md border bg-black">
                    <img
                      className="absolute inset-0 size-full object-contain"
                      src={liveTileImageUrl(sceneKey, selected.tile_id)}
                      alt={`Sentinel-1 tile ${selected.tile_id}`}
                    />
                    <svg className="absolute inset-0 size-full" viewBox="0 0 640 640" preserveAspectRatio="none" aria-hidden>
                      {tileDetections.map((detection) => (
                        <rect
                          key={detection.id}
                          x={detection.x_px - detection.w_px / 2}
                          y={detection.y_px - detection.h_px / 2}
                          width={detection.w_px}
                          height={detection.h_px}
                          fill="none"
                          stroke={detection.id === selected.id ? '#ffffff' : detection.ais_status === 'matched' ? '#2a78d6' : '#eb6834'}
                          strokeWidth={detection.id === selected.id ? 4 : 2}
                        />
                      ))}
                    </svg>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 text-sm">
                    <StatusBadge status={selected.ais_status} />
                    <div className="truncate font-medium">{selected.ais?.name || 'Unnamed vessel'}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {selected.ais ? `MMSI ${selected.ais.mmsi}` : `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}`}
                    </div>
                    <div>{(selected.conf * 100).toFixed(1)}% confidence</div>
                    {selected.ais && (
                      <div className="text-xs text-muted-foreground">
                        {selected.ais.ship_type ?? 'Unknown type'} · {selected.ais.sog_kn == null ? 'speed unknown' : `${number.format(selected.ais.sog_kn)} kn`}
                        <br />
                        Match {number.format(selected.ais_distance_m ?? 0)} m · AIS age {number.format(selected.ais.age_s)} s
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            )}
            <CardContent className="min-h-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Vessel / MMSI</TableHead>
                      <TableHead>Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detections.map((detection) => (
                      <TableRow
                        key={detection.id}
                        data-state={detection.id === selected?.id ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => setSelectedId(detection.id)}
                      >
                        <TableCell>{(detection.conf * 100).toFixed(1)}%</TableCell>
                        <TableCell><StatusBadge status={detection.ais_status} /></TableCell>
                        <TableCell>
                          {detection.ais
                            ? <>{detection.ais.name || 'Unnamed'} <span className="text-muted-foreground">({detection.ais.mmsi})</span></>
                            : '—'}
                        </TableCell>
                        <TableCell>{detection.ais?.ship_type ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                    {analysis && detections.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No vessel detections.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  )
}
