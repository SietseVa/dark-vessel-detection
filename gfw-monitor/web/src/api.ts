export interface Water {
  code: string
  name: string
}

export interface Meta {
  synced_at: string
  window_start: string
  window_end: string
  days: string
  detections_latest: string
  presence_latest: string
  events_latest: string
  counts: { detections: number; dark: number; passes: number; fishing: number; loitering: number }
  waters: Water[]
}

export interface Detection {
  ts: string // pass hour 'YYYY-MM-DD HH:00' (UTC)
  day: string // 'YYYY-MM-DD'
  lat: number
  lon: number
  matched: boolean
  n: number
  eez: string
}

export type EventType = 'fishing' | 'loitering'

export interface GfwEvent {
  id: string
  type: EventType
  start: string
  end: string
  lat: number
  lon: number
  vessel_id: string | null
  vessel_name: string | null
  mmsi: string | null
  flag: string | null
  vessel_type: string | null
  eez: string
  duration_h: number | null
  distance_km: number | null
  avg_speed_kn: number | null
  dist_shore_km: number | null
}

export interface PresenceCell {
  lat: number
  lon: number
  hours: number
}

interface Table {
  columns: string[]
  rows: unknown[][]
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`
    try {
      detail = (await r.json()).detail ?? detail
    } catch {
      /* not JSON */
    }
    throw new Error(detail)
  }
  return r.json()
}

function objects<T>(t: Table): T[] {
  return t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])) as T)
}

export const loadMeta = () => get<Meta>('/api/meta')

export async function loadDetections(): Promise<Detection[]> {
  const t = await get<Table>('/api/detections')
  return t.rows.map(([ts, lat, lon, matched, n, eez]) => ({
    ts: ts as string,
    day: (ts as string).slice(0, 10),
    lat: lat as number,
    lon: lon as number,
    matched: matched === 1,
    n: n as number,
    eez: eez as string,
  }))
}

export async function loadPresence(start: string, end: string): Promise<PresenceCell[]> {
  return objects<PresenceCell>(await get<Table>(`/api/presence?start=${start}&end=${end}`))
}

export async function loadEvents(start: string, end: string): Promise<GfwEvent[]> {
  return objects<GfwEvent>(await get<Table>(`/api/events?start=${start}&end=${end}`))
}
