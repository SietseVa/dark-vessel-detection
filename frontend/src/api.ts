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
