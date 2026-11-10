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

// Detections by predicted class. The model cannot tell AIS from dark, so its vessels are drawn
// half AIS blue, half dark orange. MODEL_HEX is the single colour where a split is not possible
// (map dots fill blue and get an orange ring; see MODEL_RING).
export const MODEL_HEX = {
  vessel: CATEGORY_HEX.ais,
  non_vessel: CATEGORY_HEX.fixed,
}

export const MODEL_RING = {
  vessel: CATEGORY_HEX.dark,
  non_vessel: '#ffffff',
}

/** CSS background for a detection dot: split blue/orange for vessels. */
export const MODEL_FILL = {
  vessel: `linear-gradient(90deg, ${CATEGORY_HEX.ais} 50%, ${CATEGORY_HEX.dark} 50%)`,
  non_vessel: CATEGORY_HEX.fixed,
}

export const MODEL_LABEL = {
  vessel: 'Vessel (model)',
  non_vessel: 'Fixed object (model)',
}

export type Layers = 'labels' | 'model' | 'both'

export const MODEL_SHORT = {
  vessel: 'Vessel',
  non_vessel: 'Fixed',
}

// Detections below this confidence are hidden everywhere in the dashboard.
export const MIN_CONF = 0.15
