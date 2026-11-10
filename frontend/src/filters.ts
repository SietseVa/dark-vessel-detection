import type { Category, Split, Tile, VesselObject } from './api'

export interface Filters {
  split: Split | 'all'
  scene: string | null
  categories: Record<Category, boolean>
  minLength: number
  /** Minimum distance to shore in km. */
  minShore: number
}

/** Distance to shore is only known within 10 km; objects without a value count as farther out. */
export const SHORE_MAX = 10

export const DEFAULT_FILTERS: Filters = {
  split: 'all',
  scene: null,
  categories: { ais: true, dark: true, fixed: true },
  minLength: 0,
  minShore: 0,
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
  // No value means more than SHORE_MAX km out, so it always passes.
  if (f.minShore > 0 && o.dist_shore_km !== null && o.dist_shore_km < f.minShore) return false
  return true
}
