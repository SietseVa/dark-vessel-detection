import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { Detection, GfwEvent, Meta, PresenceCell } from '@/api'
import { loadDetections, loadEvents, loadMeta, loadPresence } from '@/api'
import { addDays, COLORS, fmt, fmtDay, fmtPass, pct } from '@/theme'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MonitorMap, type Layers, type Selection } from '@/components/MonitorMap'
import { DailyChart, PassTimeline, WatersChart, type Split } from '@/components/Charts'
import { DetailSheet } from '@/components/DetailSheet'

type Period = '7' | '30' | '90'

const LAYER_ROWS: { key: keyof Layers; label: string; swatch: React.ReactNode }[] = [
  { key: 'dark', label: 'Dark detections (no AIS)', swatch: <Dot color={COLORS.dark} /> },
  { key: 'ais', label: 'Detections matched to AIS', swatch: <Dot color={COLORS.ais} /> },
  { key: 'heatmap', label: 'Show dark detections as heatmap', swatch: <span className="size-2.5" /> },
  { key: 'density', label: 'AIS traffic density', swatch: <span className="size-2.5 rounded-sm bg-neutral-400" /> },
  { key: 'fishing', label: 'Fishing events', swatch: <Ring color={COLORS.fishing} /> },
  { key: 'loitering', label: 'Loitering events', swatch: <Ring color={COLORS.loitering} /> },
]

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />
}
function Ring({ color }: { color: string }) {
  return (
    <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full border-2" style={{ borderColor: color }} />
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {sub && <CardDescription className="text-xs">{sub}</CardDescription>}
      </CardHeader>
    </Card>
  )
}

function split(dets: Detection[], keyOf: (d: Detection) => string): Map<string, { dark: number; ais: number }> {
  const m = new Map<string, { dark: number; ais: number }>()
  for (const d of dets) {
    const k = keyOf(d)
    const v = m.get(k) ?? { dark: 0, ais: 0 }
    if (d.matched) v.ais += d.n
    else v.dark += d.n
    m.set(k, v)
  }
  return m
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('30')
  const [waters, setWaters] = useState('ALL')
  const [pass, setPass] = useState<string | null>(null)
  const [layers, setLayers] = useState<Layers>({
    dark: true,
    ais: true,
    heatmap: false,
    density: true,
    fishing: false,
    loitering: false,
  })
  const [events, setEvents] = useState<GfwEvent[]>([])
  const [presence, setPresence] = useState<PresenceCell[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)

  useEffect(() => {
    Promise.all([loadMeta(), loadDetections()]).then(
      ([m, d]) => {
        setMeta(m)
        setDetections(d)
      },
      (e) => setError(String(e.message ?? e)),
    )
  }, [])

  // The period ends on the last day with radar data (GFW runs ~5 days behind).
  const end = meta ? (meta.detections_latest || meta.window_end).slice(0, 10) : ''
  const start = end ? addDays(end, -(Number(period) - 1)) : ''

  const needEvents = layers.fishing || layers.loitering
  useEffect(() => {
    if (!start || !layers.density) return
    let live = true
    loadPresence(start, end).then((p) => live && setPresence(p), () => {})
    return () => {
      live = false
    }
  }, [start, end, layers.density])
  useEffect(() => {
    if (!start || !needEvents) return
    let live = true
    loadEvents(start, end).then((e) => live && setEvents(e), () => {})
    return () => {
      live = false
    }
  }, [start, end, needEvents])

  const watersName = (code: string) => meta?.waters.find((w) => w.code === code)?.name ?? code

  const inPeriod = useMemo(
    () => (detections ?? []).filter((d) => d.day >= start && d.day <= end),
    [detections, start, end],
  )
  const inWaters = useMemo(
    () => (waters === 'ALL' ? inPeriod : inPeriod.filter((d) => d.eez === waters)),
    [inPeriod, waters],
  )
  const onMap = useMemo(() => (pass ? inWaters.filter((d) => d.ts === pass) : inWaters), [inWaters, pass])

  const passes: Split[] = useMemo(
    () =>
      [...split(inWaters, (d) => d.ts)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => ({ key: k, label: fmtPass(k), ...v })),
    [inWaters],
  )
  const daily: Split[] = useMemo(() => {
    const m = split(inWaters, (d) => d.day)
    const out: Split[] = []
    for (let d = start; d && d <= end; d = addDays(d, 1)) out.push({ key: d, label: fmtDay(d), ...(m.get(d) ?? { dark: 0, ais: 0 }) })
    return out
  }, [inWaters, start, end])
  const byWaters: Split[] = useMemo(() => {
    const m = split(inPeriod, (d) => d.eez)
    return (meta?.waters ?? [])
      .map((w) => ({ key: w.code, label: w.name, ...(m.get(w.code) ?? { dark: 0, ais: 0 }) }))
      .filter((w) => w.dark + w.ais > 0)
      .sort((a, b) => b.dark - a.dark)
  }, [inPeriod, meta])

  const eventsOnMap = useMemo(() => {
    let ev = waters === 'ALL' ? events : events.filter((e) => e.eez === waters)
    if (pass) {
      // events active within an hour of the selected pass
      const t = Date.parse(`${pass.replace(' ', 'T')}:00Z`)
      ev = ev.filter((e) => Date.parse(e.start) <= t + 3_600_000 && Date.parse(e.end) >= t - 3_600_000)
    }
    return ev
  }, [events, waters, pass])

  const totals = useMemo(() => {
    let dark = 0
    let ais = 0
    for (const d of onMap) {
      if (d.matched) ais += d.n
      else dark += d.n
    }
    return { dark, ais, all: dark + ais }
  }, [onMap])

  if (error)
    return (
      <div className="grid h-svh place-content-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold">Could not load data</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
        <p className="text-sm text-muted-foreground">
          Is the API running, and has the data been synced?{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">uv run python -m server.sync</code>
        </p>
      </div>
    )
  if (!meta || !detections)
    return <div className="grid h-svh place-content-center text-muted-foreground">Loading North Sea data…</div>

  return (
    <div className="grid h-svh grid-cols-1 overflow-hidden md:grid-cols-[400px_1fr]">
      <aside className="hidden min-h-0 border-r bg-sidebar md:block">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-6 p-5">
            <header className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold tracking-tight">North Sea Dark Vessel Monitor</h1>
              <p className="text-xs text-muted-foreground">
                Sentinel-1 radar detections compared with AIS, from{' '}
                <a className="underline underline-offset-2" href="https://globalfishingwatch.org" target="_blank" rel="noreferrer">
                  Global Fishing Watch
                </a>
                .
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">Radar data through {fmtDay(end)}</Badge>
                <Badge variant="outline">GFW runs ~5 days behind</Badge>
              </div>
            </header>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">Period</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  value={period}
                  onValueChange={(v) => {
                    if (!v) return
                    setPeriod(v as Period)
                    setPass(null)
                  }}
                >
                  <ToggleGroupItem value="7">7 days</ToggleGroupItem>
                  <ToggleGroupItem value="30">30 days</ToggleGroupItem>
                  <ToggleGroupItem value="90">90 days</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  {fmtDay(start)} – {fmtDay(end)} · {passes.length} satellite passes
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">Waters</Label>
                <Select value={waters} onValueChange={setWaters}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">Whole North Sea</SelectItem>
                    {meta.waters.map((w) => (
                      <SelectItem key={w.code} value={w.code}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Kpi label="Detections" value={fmt.format(totals.all)} />
              <Kpi label="Dark" value={fmt.format(totals.dark)} />
              <Kpi label="Dark share" value={pct(totals.dark, totals.all)} sub="no AIS match" />
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">Map layers</Label>
              <div className="flex flex-col gap-2.5">
                {LAYER_ROWS.map((l) => (
                  <div key={l.key} className="flex items-center gap-2.5">
                    <Checkbox
                      id={`layer-${l.key}`}
                      checked={layers[l.key]}
                      disabled={l.key === 'heatmap' && !layers.dark}
                      onCheckedChange={(v) => setLayers((s) => ({ ...s, [l.key]: v === true }))}
                    />
                    <Label htmlFor={`layer-${l.key}`} className="font-normal">
                      {l.swatch}
                      {l.label}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <Card size="sm">
              <CardHeader>
                <CardTitle>Detections per day</CardTitle>
                <CardDescription>
                  {waters === 'ALL' ? 'Whole North Sea' : watersName(waters)} · hover for the dark share
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DailyChart data={daily} />
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>By waters (EEZ)</CardTitle>
                <CardDescription>Sorted by dark detections · click a bar to filter</CardDescription>
              </CardHeader>
              <CardContent>
                <WatersChart data={byWaters} active={waters} onSelect={(c) => setWaters(waters === c ? 'ALL' : c)} />
              </CardContent>
            </Card>

            <p className="text-xs leading-relaxed text-muted-foreground">
              “Dark” means GFW found no AIS signal for a radar detection: the vessel was not publicly tracked. Small
              boats are often not required to carry AIS, and GFW detects vessels under ~25 m less reliably. Positions are
              on a ~1 km grid. Data: Global Fishing Watch, non-commercial use.
            </p>
          </div>
        </ScrollArea>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col">
        <div className="relative min-h-0 flex-1">
          <MonitorMap
            detections={onMap}
            events={eventsOnMap}
            presence={layers.density ? presence : []}
            layers={layers}
            onSelect={setSelection}
          />
        </div>
        <section className="border-t bg-background px-4 pt-2.5 pb-1" aria-label="Satellite passes">
          <div className="flex items-center gap-2">
            <h2 className="shrink-0 text-sm font-medium">{pass ? `Pass ${fmtPass(pass)}` : 'Satellite passes'}</h2>
            {pass && (
              <Button variant="ghost" size="icon-xs" onClick={() => setPass(null)} aria-label="Show all passes">
                <X />
              </Button>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {pass
                ? `${fmt.format(totals.all)} detections, ${pct(totals.dark, totals.all)} dark · click the bar again to show all passes`
                : 'Each bar is one Sentinel-1 pass · click a bar to show only that pass'}
            </p>
          </div>
          <PassTimeline data={passes} selected={pass} onSelect={setPass} />
        </section>
      </main>

      <DetailSheet selection={selection} watersName={watersName} onClose={() => setSelection(null)} />
    </div>
  )
}
