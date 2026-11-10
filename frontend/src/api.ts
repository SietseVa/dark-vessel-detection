export type Split = 'train' | 'val'
export type Category = 'ais' | 'dark' | 'fixed'
export type Counts = Record<Category, number>

export interface Summary {
  n_scenes: number
  n_tiles: number
  tiles_by_split: Record<Split, number>
  n_objects: number
  objects_by_category: Counts
}

export interface Scene {
  scene_id: string
  split: Split
  n_tiles: number
  n_empty_tiles: number
  counts: Counts
  bbox: [number, number, number, number]
  center: [number, number]
  georef_max_err_m: number
}

export interface Tile {
  tile_id: string
  split: Split
  scene_id: string
  tile_row: number
  tile_col: number
  pixel_row: number
  pixel_col: number
  valid_fraction: number
  counts: Counts
  corners: [number, number][]
  center: [number, number]
}

export interface VesselObject {
  id: number
  tile_id: string
  scene_id: string
  split: Split
  class: 'vessel' | 'non_vessel'
  category: Category
  source: 'ais' | 'ais/manual' | 'manual'
  confidence: 'MEDIUM' | 'HIGH'
  x_px: number
  y_px: number
  w_px: number
  h_px: number
  length_m: number | null
  is_fishing: boolean | null
  dist_shore_km: number | null
  lat: number
  lon: number
}

export interface Dataset {
  summary: Summary
  scenes: Scene[]
  tiles: Tile[]
  objects: VesselObject[]
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`)
  return r.json()
}

export async function loadDataset(): Promise<Dataset> {
  const [summary, scenes, tiles, objects] = await Promise.all([
    get<Summary>('/api/summary'),
    get<Scene[]>('/api/scenes'),
    get<Tile[]>('/api/tiles'),
    get<VesselObject[]>('/api/objects'),
  ])
  return { summary, scenes, tiles, objects }
}

export const tileImageUrl = (id: string) => `/api/tiles/${encodeURIComponent(id)}/image`
export const tileThumbUrl = (id: string, size = 192) =>
  `/api/tiles/${encodeURIComponent(id)}/thumb?size=${size}`

// ---- YOLO model -------------------------------------------------------------------------------

export interface TrainingMetrics {
  epochs_trained: number
  best_epoch: number
  precision: number
  recall: number
  map50: number
  map50_95: number
}

export type ModelInfo =
  | { available: false }
  | {
      available: true
      name: string
      weights: string
      imgsz: number
      classes: string[]
      training: TrainingMetrics | null
      predicted_tiles: number
      /** Threshold with the best vessel F1 on the validation tiles (null until predictions exist). */
      best_vessel_threshold: { conf: number; f1: number; precision: number; recall: number } | null
    }

/** One model detection. match_id is the id of the labelled object it was matched to (within
 *  200 m, highest confidence first), or null when the model found something nobody labelled. */
export interface Detection {
  id: string
  tile_id: string
  scene_id: string
  split: Split
  class: 'vessel' | 'non_vessel'
  conf: number
  x_px: number
  y_px: number
  w_px: number
  h_px: number
  lat: number
  lon: number
  match_id: number | null
}

export interface Predictions {
  model: string
  min_conf: number
  tile_ids: string[]
  detections: Detection[]
}

export const loadModel = () => get<ModelInfo>('/api/model')
export const loadPredictions = () => get<Predictions>('/api/predictions')
export const loadTileDetections = (id: string) =>
  get<Detection[]>(`/api/tiles/${encodeURIComponent(id)}/detections`)

export type DetectionCounts = Record<Detection['class'], number>

// ---- Newly downloaded Sentinel-1 scenes -------------------------------------------------------

export interface LiveScene {
  key: string
  scene_id: string | null
  area: string
  acquired_utc: string
  tile_count: number
  ais_count: number
  ais_covered: boolean
}

export interface LiveTile {
  tile_id: string
  tile_row: number
  tile_col: number
  corners: [number, number][]
  center: [number, number]
}

export interface LiveAIS {
  mmsi: number
  name: string | null
  ship_type: string | null
  lat: number
  lon: number
  sar_lat: number
  sar_lon: number
  sog_kn: number | null
  cog_deg: number | null
  heading_deg: number | null
  age_s: number
  method: string
  length_m: number | null
  width_m: number | null
}

export interface LiveDetection {
  id: string
  tile_id: string
  conf: number
  x_px: number
  y_px: number
  w_px: number
  h_px: number
  lat: number
  lon: number
  ais_status: 'matched' | 'potential_dark' | 'unknown'
  ais_distance_m: number | null
  ais: LiveAIS | null
}

export interface LiveAnalysisResult {
  scene_id: string | null
  scene_key: string
  area: string
  acquired_utc: string
  model: string | null
  min_conf: number
  match_radius_m: number
  ais_covered: boolean
  ais_count: number
  detections: LiveDetection[]
}

async function post<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: 'POST' })
  if (!r.ok) {
    const message = await r.text()
    throw new Error(`${path}: ${r.status} ${message || r.statusText}`)
  }
  return r.json()
}

export const loadLiveScenes = () => get<LiveScene[]>('/api/live/scenes')
export const loadLiveTiles = (key: string) =>
  get<LiveTile[]>(`/api/live/scenes/${encodeURIComponent(key)}/tiles`)
export const analyzeLiveScene = (key: string) =>
  post<LiveAnalysisResult>(`/api/live/scenes/${encodeURIComponent(key)}/analyze`)
export const liveTileImageUrl = (sceneKey: string, tileId: string) =>
  `/api/live/scenes/${encodeURIComponent(sceneKey)}/tiles/${encodeURIComponent(tileId)}/image`
