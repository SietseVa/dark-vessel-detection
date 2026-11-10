import { ExternalLink } from 'lucide-react'
import { cropUrl, type AisShip, type Detection } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { COLORS, fmtPos, fmtTime, INFRA, num } from '@/theme'
import type { Selection } from './SceneMap'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums">{value}</span>
    </div>
  )
}

function Crop({ id, pol, caption }: { id: string; pol: 'vv' | 'before'; caption: string }) {
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={cropUrl(id, pol)}
        alt={caption}
        className="aspect-square w-full rounded-md border bg-black [image-rendering:pixelated]"
      />
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  )
}

function ShipRows({ ship }: { ship: AisShip }) {
  return (
    <>
      <Row label="MMSI" value={ship.mmsi} />
      <Row label="Type" value={ship.ship_type ?? '–'} />
      <Row label="Length × width (AIS)" value={ship.length_m ? `${num(ship.length_m, 'm')} × ${num(ship.width_m, 'm')}` : '–'} />
      <Row label="Speed" value={num(ship.sog_kn, 'kn', 1)} />
      <Row label="Course" value={ship.cog_deg == null ? '–' : `${ship.cog_deg.toFixed(0)}°`} />
      <Row label="AIS position" value={fmtPos(ship.lat, ship.lon)} />
      <Row label="Nearest AIS message" value={`${ship.age_s.toFixed(0)} s from the pass`} />
    </>
  )
}

function MarineTraffic({ mmsi }: { mmsi: number }) {
  return (
    <Button asChild variant="outline" size="sm" className="mt-4">
      <a href={`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}`} target="_blank" rel="noreferrer">
        Look up on MarineTraffic <ExternalLink />
      </a>
    </Button>
  )
}

function DetectionDetail({ d, ship }: { d: Detection; ship: AisShip | undefined }) {
  const isDark = d.mmsi == null
  return (
    <>
      <SheetHeader>
        <SheetDescription>Sentinel-1 radar detection</SheetDescription>
        <SheetTitle className="flex items-center gap-2 text-lg">
          <span className="inline-block size-3 rounded-full" style={{ background: isDark ? COLORS.dark : COLORS.matched }} />
          {isDark ? 'No AIS match: dark candidate' : (ship?.name ?? `Matched to MMSI ${d.mmsi}`)}
        </SheetTitle>
        {!isDark && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="secondary">Matched to AIS</Badge>
            <Badge variant="outline">{num(d.distance_m, 'm')} apart</Badge>
          </div>
        )}
      </SheetHeader>
      <div className="px-4 pb-6">
        <div className="grid grid-cols-2 gap-3">
          <Crop id={d.id} pol="vv" caption="This pass" />
          <Crop id={d.id} pol="before" caption="Same spot, previous pass" />
        </div>
        <p className="pt-1.5 text-xs text-muted-foreground">
          Each cut-out is about 700 m across. Something visible in both is a fixed object, not a ship.
        </p>
        <Separator className="my-3" />
        <h3 className="pb-1 text-sm font-medium">What the model sees</h3>
        <Row label="Confidence" value={`${(d.score * 100).toFixed(1)}%`} />
        <Row label="Estimated length × width" value={`${num(d.length_m, 'm')} × ${num(d.width_m, 'm')}`} />
        <Row label="Estimated speed" value={num(d.speed_kn, 'kn', 1)} />
        <Row label="Estimated heading" value={d.heading_deg == null ? '–' : `${d.heading_deg.toFixed(0)}° or ${((d.heading_deg + 180) % 360).toFixed(0)}°`} />
        <Row label="Fishing vessel score" value={d.fishing_score == null ? '–' : `${(d.fishing_score * 100).toFixed(0)}%`} />
        <Row label="Position" value={fmtPos(d.lat, d.lon)} />
        <Row label="Imaged at" value={fmtTime(d.ts)} />
        <Row
          label="Nearest infrastructure"
          value={
            d.near
              ? `${INFRA[d.near.kind].label}${d.near.name ? ` ${d.near.name}` : ''}, ${d.near.distance_m === 0 ? 'inside' : num(d.near.distance_m, 'm')}`
              : 'none within 5 km'
          }
        />
        <Separator className="my-3" />
        {ship ? (
          <>
            <h3 className="pb-1 text-sm font-medium">What AIS says</h3>
            <ShipRows ship={ship} />
            <MarineTraffic mmsi={ship.mmsi} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No ship was broadcasting AIS within reach of this detection at the moment of the pass. That makes it a dark
            candidate, not proof: it can be a ship with AIS switched off, a small boat that does not have to carry AIS,
            or a fixed object such as a wind turbine or platform.
          </p>
        )}
      </div>
    </>
  )
}

function ShipDetail({ ship }: { ship: AisShip }) {
  const found = ship.detection_id != null
  return (
    <>
      <SheetHeader>
        <SheetDescription className="flex items-center gap-2">
          <span className="inline-block size-3 rounded-full border-2" style={{ borderColor: found ? COLORS.matched : COLORS.aisOnly }} />
          Ship broadcasting AIS
        </SheetDescription>
        <SheetTitle className="text-lg">{ship.name ?? `MMSI ${ship.mmsi}`}</SheetTitle>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="secondary">{found ? 'Detected on radar' : 'Not detected on radar'}</Badge>
          {found && <Badge variant="outline">{num(ship.distance_m, 'm')} apart</Badge>}
        </div>
      </SheetHeader>
      <div className="px-4 pb-6">
        <ShipRows ship={ship} />
        <Separator className="my-3" />
        <p className="text-sm text-muted-foreground">
          {found
            ? 'The radar detection lies within reach of where AIS places this ship at the moment of the pass.'
            : 'AIS places this ship inside the image, but the model found nothing there. Small boats, ships alongside a quay and ships in rough sea are the usual reasons.'}
        </p>
        <MarineTraffic mmsi={ship.mmsi} />
      </div>
    </>
  )
}

export function DetailSheet({
  selection,
  ships,
  onClose,
}: {
  selection: Selection | null
  ships: AisShip[]
  onClose: () => void
}) {
  return (
    <Sheet open={!!selection} onOpenChange={(o) => !o && onClose()} modal={false}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
      >
        {selection?.kind === 'detection' && (
          <DetectionDetail d={selection.item} ship={ships.find((s) => s.detection_id === selection.item.id)} />
        )}
        {selection?.kind === 'ship' && <ShipDetail ship={selection.item} />}
      </SheetContent>
    </Sheet>
  )
}
