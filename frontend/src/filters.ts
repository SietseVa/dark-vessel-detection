import type { Category, Split, Tile, VesselObject } from './api'

export type Fishing = 'any' | 'fishing' | 'not_fishing' | 'unknown'

export interface Filters {
  split: Split | 'all'
  scene: string | null
  categories: Record<Category, boolean>
  fishing: Fishing
  minLength: number
}

export const DEFAULT_FILTERS: Filters = {
  split: 'all',
  scene: null,
  categories: { ais: true, dark: true, fixed: true },
  fishing: 'any',
  minLength: 0,
}

export function tileMatches(t: Tile, f: Filters): boolean {
  if (f.split !== 'all' && t.split !== f.split) return false
  if (f.scene && t.scene_id !== f.scene) return false
  return true
}

export function objectMatches(o: VesselObject, f: Filters): boolean {
  if (f.split !== 'all' && o.split !== f.split) return false
  if (f.scene && o.scene_id !== f.scene) return false
  if (!f.categories[o.category]) return false
  if (f.fishing === 'fishing' && o.is_fishing !== true) return false
  if (f.fishing === 'not_fishing' && o.is_fishing !== false) return false
  if (f.fishing === 'unknown' && o.is_fishing !== null) return false
  if (f.minLength > 0 && (o.length_m === null || o.length_m < f.minLength)) return false
  return true
}
