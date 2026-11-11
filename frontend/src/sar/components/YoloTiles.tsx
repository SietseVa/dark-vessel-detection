import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

type Tile = { id: string; row: number; col: number; x: number; y: number; width: number; height: number }
type Detection = { id: number; tile_id: string; box: number[]; score: number; label: string; x: number; y: number; lon: number; lat: number; mmsi: number | null; distance_m: number | null }
type Ship = { mmsi: number; name?: string; x: number; y: number; lat: number; lon: number; age_s: number; method: string; detection_id: number | null }
type Results = {
  scene: { area: string; acquired_utc: string; size_px: number[]; pixel_m: number; processing: string }
  tiles: Tile[]; tile_size: number; overlap: number; verified_overlaps: number
  detections: Detection[]; ships: Ship[]; raw_detections: number; elapsed_s: number
  model: { name: string; confidence: number; weights: string }
  matching: { radius_m: number; method: string }
}
const amber = '#fb923c', blue = '#38bdf8', green = '#4ade80'

export function YoloTiles() {
  const [data, setData] = useState<Results | null>(null)
  const [error, setError] = useState('')
  const [tileId, setTileId] = useState('')
  const [confidence, setConfidence] = useState(25)
  const [showAis, setShowAis] = useState(true)
  const [showBoxes, setShowBoxes] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<Detection | Ship | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/sar-api/yolo-tiles', { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error((await r.json()).detail || 'Could not load tile inference')
      return r.json() as Promise<Results>
    }).then(d => {
      setData(d)
      const best = [...d.detections].sort((a, b) => b.score - a.score)[0]
      setTileId(best?.tile_id ?? d.tiles[0]?.id ?? '')
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [])
  const detections = useMemo(() => data?.detections.filter(d => d.score * 100 >= confidence) ?? [], [data, confidence])
  if (error) return <div role="alert" className="p-10"><h1 className="text-xl font-semibold">Tile inference unavailable</h1><p className="mt-3 text-muted-foreground">{error}</p></div>
  if (!data) return <div className="p-10 text-muted-foreground">Loading tiles and inference…</div>
  const tile = data.tiles.find(t => t.id === tileId) ?? data.tiles[0]
  if (!tile) return <div className="p-10">No tiles were imported.</div>
  const inside = (p: { x: number; y: number }) => p.x >= tile.x && p.x < tile.x + tile.width && p.y >= tile.y && p.y < tile.y + tile.height
  const localDetections = detections.filter(d => d.box[2] > tile.x && d.box[0] < tile.x + tile.width && d.box[3] > tile.y && d.box[1] < tile.y + tile.height)
  const localShips = data.ships.filter(inside)
  const matched = detections.filter(d => d.mmsi !== null).length
  const choose = (t: Tile) => { setTileId(t.id); setSelection(null); setZoom(1) }
  const index = data.tiles.indexOf(tile)
  const [width, height] = data.scene.size_px
  const selectedShip = selection && ('score' in selection ? data.ships.find(s => s.mmsi === selection.mmsi) : selection)
  return (
    <div className="grid h-full overflow-auto lg:grid-cols-[340px_1fr] lg:overflow-hidden">
      <aside className="space-y-5 border-r bg-sidebar p-5 lg:overflow-y-auto">
        <header><Badge variant="outline">Independent inference</Badge><h1 className="mt-3 text-xl font-semibold">Aarhus Bay · YOLO</h1><p className="mt-2 text-xs text-muted-foreground">{new Date(data.scene.acquired_utc).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC<br />{data.tiles.length} tiles · {data.scene.pixel_m} m / pixel</p></header>
        <div className="grid grid-cols-2 gap-3">
          {[[detections.length, 'YOLO detections'], [data.ships.length, 'AIS ships'], [matched, 'Near AIS'], [detections.length - matched, 'Without nearby AIS']].map(([n, label]) => <div key={label} className="rounded-lg border bg-card p-3"><div className="text-2xl font-semibold tabular-nums">{n}</div><div className="text-xs text-muted-foreground">{label}</div></div>)}
        </div>
        <div><label htmlFor="yolo-confidence" className="flex justify-between text-sm">Minimum confidence <span>{confidence}%</span></label><input id="yolo-confidence" className="mt-3 w-full accent-orange-500" type="range" min={Math.ceil(data.model.confidence * 100)} max="95" step="5" value={confidence} onChange={e => { setConfidence(+e.target.value); setSelection(null) }} /></div>
        <div className="flex gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={showBoxes} onChange={e => setShowBoxes(e.target.checked)} />YOLO boxes</label><label className="flex items-center gap-2"><input type="checkbox" checked={showAis} onChange={e => setShowAis(e.target.checked)} />AIS positions</label></div>
        <section><h2 className="mb-2 text-sm font-medium">Scene overview <span className="font-normal text-muted-foreground">· select a tile</span></h2>
          <svg aria-label="Scene overview with selectable tiles" viewBox={`0 0 ${width} ${height}`} className="w-full rounded-lg bg-black">
            <image href="/sar-api/yolo-tiles/overview.jpg" width={width} height={height} preserveAspectRatio="none" />
            {data.tiles.map(t => <rect key={t.id} x={t.x} y={t.y} width={t.width} height={t.height} fill={tile.id === t.id ? '#fb923c44' : 'transparent'} stroke={tile.id === t.id ? amber : '#ffffff55'} strokeWidth={tile.id === t.id ? 25 : 8} className="cursor-pointer" onClick={() => choose(t)}><title>Row {t.row + 1}, column {t.col + 1}</title></rect>)}
            {showBoxes && detections.map(d => <circle key={d.id} cx={d.x} cy={d.y} r="20" fill={d.mmsi ? green : amber} pointerEvents="none" />)}
            {showAis && data.ships.map(s => <circle key={s.mmsi} cx={s.x} cy={s.y} r="28" fill="none" stroke={blue} strokeWidth="10" pointerEvents="none" />)}
          </svg>
          <label className="mt-3 block text-xs text-muted-foreground" htmlFor="tile-picker">Tile</label><select id="tile-picker" className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={tile.id} onChange={e => choose(data.tiles.find(t => t.id === e.target.value)!)}>{data.tiles.map(t => <option key={t.id} value={t.id}>Row {t.row + 1} · Column {t.col + 1}</option>)}</select>
        </section>
        <p className="text-xs leading-relaxed text-muted-foreground">AIS is interpolated or extrapolated to acquisition time using archived messages no more than 10 minutes away. “Near AIS” is a one-to-one association within {data.matching.radius_m} m at the inference floor ({data.model.confidence * 100}%). Radar displacement is not corrected; an unmatched detection is not proof of a dark vessel.</p>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Model and processing</summary><p className="mt-2 leading-relaxed">{data.model.name} / {data.model.weights}<br />{data.raw_detections} raw → {data.detections.length} unique detections.<br />{data.overlap}px overlap; {data.verified_overlaps} adjacent edges verified.<br />{data.scene.processing}</p></details>
      </aside>
      <main className="min-w-0 space-y-4 p-5 lg:overflow-y-auto">
        <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Tile {tile.row + 1} / {tile.col + 1}</h2><p className="text-xs text-muted-foreground">{localDetections.length} detections · {localShips.length} AIS ships · RGB: VV / VH / mean</p></div><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={index === 0} onClick={() => choose(data.tiles[index-1])}>Previous</Button><Button variant="outline" size="sm" disabled={index === data.tiles.length-1} onClick={() => choose(data.tiles[index+1])}>Next</Button><Button variant="outline" size="sm" onClick={() => setZoom(zoom === 1 ? 2 : 1)}>{zoom === 1 ? 'Zoom 2×' : 'Fit tile'}</Button></div></header>
        <div className="flex flex-wrap gap-4 text-xs"><span style={{ color: amber }}>□ YOLO · no nearby AIS</span><span style={{ color: green }}>□ YOLO · near AIS</span><span style={{ color: blue }}>○ AIS position</span></div>
        <div className="max-h-[72vh] overflow-auto rounded-xl border bg-[#090c10]">
          <svg aria-label={`Tile row ${tile.row + 1} column ${tile.col + 1}, YOLO detections and AIS positions`} viewBox={`0 0 ${data.tile_size} ${data.tile_size}`} style={{ width: zoom === 1 ? '100%' : '200%', maxWidth: zoom === 1 ? 900 : 1800, display: 'block', margin: 'auto' }}>
            <image href={`/sar-api/yolo-tiles/images/${tile.id}.png`} width={data.tile_size} height={data.tile_size} />
            {showBoxes && localDetections.map(d => <g key={d.id} onClick={() => setSelection(d)} className="cursor-pointer"><rect x={d.box[0]-tile.x} y={d.box[1]-tile.y} width={d.box[2]-d.box[0]} height={d.box[3]-d.box[1]} fill="transparent" stroke={d.mmsi ? green : amber} strokeWidth="1.6" /><text x={Math.max(2, d.box[0]-tile.x)} y={Math.max(12, d.box[1]-tile.y-4)} fill={d.mmsi ? green : amber} stroke="#000" strokeWidth="2" paintOrder="stroke" fontSize="10">{Math.round(d.score * 100)}%</text><title>{d.label} · {(d.score*100).toFixed(1)}% · click for details</title></g>)}
            {showAis && localShips.map(s => <g key={s.mmsi} className="cursor-pointer" onClick={() => setSelection(s)}><circle cx={s.x-tile.x} cy={s.y-tile.y} r="7" fill="#38bdf822" stroke={blue} strokeWidth="1.8" /><path d={`M${s.x-tile.x-11},${s.y-tile.y}h22 M${s.x-tile.x},${s.y-tile.y-11}v22`} stroke={blue} strokeWidth="0.7" /><title>{s.name || s.mmsi} · AIS · click for details</title></g>)}
          </svg>
        </div>
        <section className="rounded-lg border bg-card p-4" aria-live="polite">{selection ? <><h3 className="font-semibold">{'score' in selection ? `YOLO detection #${selection.id} · ${selection.label}` : selection.name || `MMSI ${selection.mmsi}`}</h3><p className="mt-1 text-sm text-muted-foreground">{'score' in selection && `${(selection.score*100).toFixed(1)}% confidence · `}{selection.lat.toFixed(5)}° N, {selection.lon.toFixed(5)}° E</p>{selectedShip ? <p className="mt-2 text-sm">AIS: {selectedShip.name || 'Unnamed vessel'} · MMSI {selectedShip.mmsi} · nearest message {Math.round(selectedShip.age_s)}s from pass · {selectedShip.method}{'score' in selection && selection.distance_m !== null ? ` · ${Math.round(selection.distance_m)}m separation` : ''}</p> : <p className="mt-2 text-sm">No AIS proximity match within {data.matching.radius_m}m.</p>}</> : <p className="text-sm text-muted-foreground">Select a detection box or AIS ring to inspect its position and vessel details.</p>}</section>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-medium">Detections in this tile</caption><thead className="border-b text-xs text-muted-foreground"><tr><th className="p-2">Detection</th><th>Confidence</th><th>Model class</th><th>Nearby AIS</th></tr></thead><tbody>{localDetections.map(d => <tr key={d.id} className="border-b hover:bg-muted"><td className="p-2"><button className="underline underline-offset-4" onClick={() => setSelection(d)}>#{d.id}</button></td><td>{(d.score*100).toFixed(1)}%</td><td>{d.label}</td><td>{d.mmsi ? `${data.ships.find(s => s.mmsi === d.mmsi)?.name || d.mmsi} · ${Math.round(d.distance_m!)}m` : 'None within radius'}</td></tr>)}</tbody></table>{!localDetections.length && <p className="p-3 text-sm text-muted-foreground">No detections at this confidence. AIS positions remain visible.</p>}</div>
      </main>
    </div>
  )
}
