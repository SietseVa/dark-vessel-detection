export interface Scene {
  id: string
  region: string
  platform: string
  start_ts: number // UTC epoch seconds
  end_ts: number
  orbit_state: string | null
  footprint: [number, number][] // lon, lat
  detect_seconds: number | null
  detections: number
  ais_ships: number
  matched: number
  quicklook: { west: number; north: number; east: number; south: number } | null
  tiles: boolean // full-resolution map tiles are available
}

export interface Detection {
  id: string
  ts: number
  lat: number
  lon: number
  score: number
  length_m: number | null
  width_m: number | null
  heading_deg: number | null
  heading_conf: number | null
  speed_kn: number | null
  fishing_score: number | null
  mmsi: number | null // set when matched to an AIS ship
  distance_m: number | null
  near: Nearby | null // closest infrastructure within 5 km
}

export type InfraKind = 'wind_farm' | 'platform' | 'pipeline' | 'power_cable' | 'telecom_cable'

export interface Nearby {
  kind: InfraKind
  name: string | null
  detail: string | null
  distance_m: number
}

export interface InfraProps {
  kind: InfraKind
  name: string | null
  status: string | null
  detail: string | null
}

export type Infrastructure = GeoJSON.FeatureCollection<GeoJSON.Geometry, InfraProps>

export interface AisShip {
  scene_id: string
  mmsi: number
  lat: number // where AIS says the ship was
  lon: number
  sar_lat: number // where it should appear in the radar image
  sar_lon: number
  sog_kn: number | null
  cog_deg: number | null
  heading_deg: number | null
  age_s: number
  method: string
  name: string | null
  ship_type: string | null
  length_m: number | null
  width_m: number | null
  detection_id: string | null
  distance_m: number | null
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

export const loadScenes = () => get<Scene[]>('/sar-api/scenes')
export const loadDetections = (scene: string) => get<Detection[]>(`/sar-api/scenes/${scene}/detections`)
export const loadAis = (scene: string) => get<AisShip[]>(`/sar-api/scenes/${scene}/ais`)

export const loadInfrastructure = () => get<Infrastructure>('/sar-api/infrastructure')

export const tilesUrl = (scene: string) => `${location.origin}/sar-api/scenes/${scene}/tiles/{z}/{x}/{y}.png`
export const quicklookUrl = (scene: string) => `/sar-api/scenes/${scene}/quicklook.png`

/** Radar cut-out around a detection. The detection id ends in its number within the scene. */
export function cropUrl(detectionId: string, pol: 'vv' | 'vh' | 'before') {
  const cut = detectionId.lastIndexOf('_')
  return `/sar-api/scenes/${detectionId.slice(0, cut)}/crops/${detectionId.slice(cut + 1)}/${pol}.png`
}
