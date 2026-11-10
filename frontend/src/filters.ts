import type { Category, Split, Tile, VesselObject } from './api'

export interface Filters {
  split: Split | 'all'
  scene: string | null
  categories: Record<Category, boolean>
  minLength: number
}

export const DEFAULT_FILTERS: Filters = {
  split: 'all',
  scene: null,
  categories: { ais: true, dark: true, fixed: true },
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
  if (f.minLength > 0 && (o.length_m === null || o.length_m < f.minLength)) return false
  return true
}
