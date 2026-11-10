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
