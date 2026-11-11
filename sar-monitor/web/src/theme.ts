// The shadcn base theme is neutral; these are the only data colours. Radar detections are
// filled dots, AIS ships are hollow rings, so the two never rely on hue alone.
export const COLORS = {
  matched: '#1f9d55',
  dark: '#e02d2d',
  aisOnly: '#6250d6',
} as const

// Infrastructure is drawn as thin lines and outlines in muted colours, under the vessel markers.
export const INFRA: Record<string, { label: string; color: string }> = {
  wind_farm: { label: 'Wind farm', color: '#2a78d6' },
  platform: { label: 'Platform', color: '#1f1f1f' },
  pipeline: { label: 'Pipeline', color: '#8a5a2b' },
  power_cable: { label: 'Power cable', color: '#c99a06' },
  telecom_cable: { label: 'Telecom cable', color: '#c2378f' },
}

export function rgb(hex: string, a = 255): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
}

export const fmt = new Intl.NumberFormat('en-GB')
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
})

export const fmtDateTime = (epoch: number) => `${dateTimeFmt.format(new Date(epoch * 1000))} UTC`
export const fmtTime = (epoch: number) => `${timeFmt.format(new Date(epoch * 1000))} UTC`

export const num = (v: number | null | undefined, unit: string, digits = 0) =>
  v == null ? '–' : `${v.toFixed(digits)} ${unit}`

export const fmtPos = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`

export const REGION_NAMES: Record<string, string> = {
  nl: 'Dutch North Sea',
  dk: 'Danish waters',
}
