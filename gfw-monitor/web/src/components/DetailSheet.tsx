import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { COLORS, fmt, fmtDateTime, fmtPass, titleCase } from '@/theme'
import type { Selection } from './MonitorMap'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  )
}

const num = (v: number | null, unit: string, digits = 1) => (v == null ? '–' : `${v.toFixed(digits)} ${unit}`)

function duration(h: number | null) {
  if (h == null) return '–'
  if (h < 48) return `${h.toFixed(1)} h`
  return `${fmt.format(Math.round(h / 24))} days`
}

export function DetailSheet({
  selection,
  watersName,
  onClose,
}: {
  selection: Selection | null
  watersName: (code: string) => string
  onClose: () => void
}) {
  return (
    <Sheet open={!!selection} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {selection?.kind === 'detection' && (
          <>
            <SheetHeader>
              <SheetDescription>Sentinel-1 radar detection</SheetDescription>
              <SheetTitle className="flex items-center gap-2 text-lg">
                <span
                  className="inline-block size-3 rounded-full"
                  style={{ background: selection.item.matched ? COLORS.ais : COLORS.dark }}
                />
                {selection.item.matched ? 'Matched to AIS' : 'Dark vessel: no AIS match'}
              </SheetTitle>
            </SheetHeader>
            <div className="px-4">
              <Row label="Satellite pass" value={fmtPass(selection.item.ts)} />
              <Row label="Waters" value={watersName(selection.item.eez)} />
              <Row
                label="Position (~1 km grid)"
                value={`${selection.item.lat.toFixed(2)}° N, ${selection.item.lon.toFixed(2)}° E`}
              />
              <Row label="Detections in this cell" value={selection.item.n} />
              <Separator className="my-3" />
              <p className="text-sm text-muted-foreground">
                {selection.item.matched
                  ? 'Global Fishing Watch matched this radar detection to an AIS signal at the time of the pass.'
                  : 'Global Fishing Watch found no AIS signal for this radar detection. That means the vessel was not publicly tracked: it can have AIS switched off, but small boats are often not required to carry AIS at all.'}
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                The vessel behind a detection is not available: GFW has temporarily paused that part of its API.
              </p>
            </div>
          </>
        )}
        {selection?.kind === 'event' && (
          <>
            <SheetHeader>
              <SheetDescription className="flex items-center gap-2">
                <span
                  className="inline-block size-3 rounded-full border-2"
                  style={{ borderColor: COLORS[selection.item.type] }}
                />
                {selection.item.type === 'fishing' ? 'Fishing event' : 'Loitering event'} (from AIS)
              </SheetDescription>
              <SheetTitle className="text-lg">{selection.item.vessel_name ?? 'Unknown vessel'}</SheetTitle>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {selection.item.flag && <Badge variant="secondary">Flag {selection.item.flag}</Badge>}
                <Badge variant="secondary">{titleCase(selection.item.vessel_type)}</Badge>
              </div>
            </SheetHeader>
            <div className="px-4">
              <Row label="MMSI" value={selection.item.mmsi ?? '–'} />
              <Row label="Start" value={fmtDateTime(selection.item.start)} />
              <Row label="End" value={fmtDateTime(selection.item.end)} />
              <Row label="Duration" value={duration(selection.item.duration_h)} />
              <Row label="Average speed" value={num(selection.item.avg_speed_kn, 'kn')} />
              <Row label="Distance covered" value={num(selection.item.distance_km, 'km', 0)} />
              <Row label="Distance from shore" value={num(selection.item.dist_shore_km, 'km', 0)} />
              <Row label="Waters" value={watersName(selection.item.eez)} />
              <Separator className="my-3" />
              <p className="text-sm text-muted-foreground">
                {selection.item.type === 'fishing'
                  ? 'GFW classifies a stretch of AIS track as fishing from the vessel’s movement pattern.'
                  : 'Loitering: the vessel stayed at low speed in one area for a long time, away from port.'}
              </p>
              {selection.item.mmsi && (
                <Button asChild variant="outline" size="sm" className="mt-4">
                  <a
                    href={`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${selection.item.mmsi}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Look up on MarineTraffic <ExternalLink />
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
