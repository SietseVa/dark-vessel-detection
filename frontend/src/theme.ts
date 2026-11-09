import type { ChartConfig } from '@/components/ui/chart'
import type { Category } from './api'

// The shadcn base theme is fully neutral (its --chart-* tokens are greys), which cannot tell
// the three object types apart. These are the only data colours in the app: categorical
// slots 1-3 of a colour-vision-deficiency-validated palette.
export const CATEGORY_HEX: Record<Category, string> = {
  ais: '#2a78d6',
  dark: '#eb6834',
  fixed: '#1baf7a',
}

export const CATEGORY_LABEL: Record<Category, string> = {
  ais: 'Vessel with AIS',
  dark: 'Dark vessel (no AIS)',
  fixed: 'Fixed object',
}

export const CATEGORY_SHORT: Record<Category, string> = {
  ais: 'AIS',
  dark: 'Dark',
  fixed: 'Fixed',
}

export const CATEGORIES: Category[] = ['ais', 'dark', 'fixed']

export const chartConfig = {
  ais: { label: 'AIS vessel', color: CATEGORY_HEX.ais },
  dark: { label: 'Dark vessel', color: CATEGORY_HEX.dark },
  fixed: { label: 'Fixed object', color: CATEGORY_HEX.fixed },
} satisfies ChartConfig

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const fmt = new Intl.NumberFormat('en-US')

// Model detections in the tile viewer (drawn over dark radar, dashed so they never read as labels).
export const DETECTION_HEX = {
  matched: '#ffffff', // matches a label
  unmatched: '#f2c94c', // nothing labelled here: false alarm, or a vessel the labels missed
}
