import type { ChartConfig } from '@/components/ui/chart'

// The shadcn base theme is neutral; these are the only data colours. Detections are filled dots,
// events are hollow rings, so blue/violet never rely on hue alone.
export const COLORS = {
  ais: '#2a78d6',
  dark: '#eb6834',
  fishing: '#1baf7a',
  loitering: '#6250d6',
} as const

export const chartConfig = {
  dark: { label: 'Dark (no AIS)', color: COLORS.dark },
  ais: { label: 'Matched to AIS', color: COLORS.ais },
} satisfies ChartConfig

export function rgb(hex: string, a = 255): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
}

export const fmt = new Intl.NumberFormat('en-GB')
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

export const fmtDay = (d: string) => dateFmt.format(new Date(`${d.slice(0, 10)}T00:00:00Z`))
export const fmtPass = (ts: string) => `${fmtDay(ts)} ${ts.slice(11, 16)} UTC`
export const fmtDateTime = (iso: string) => `${dateTimeFmt.format(new Date(iso))} UTC`

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export const titleCase = (s: string | null) =>
  s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bNon /, 'Non-') : '–'
