import { useId } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import type { Category } from '@/api'
import { CATEGORIES, CATEGORY_HEX, CATEGORY_SHORT, MODEL_FILL, MODEL_HEX, chartConfig } from '@/theme'

/** One bar (or bin): a label plus a count per series key. */
export type BinDatum = { label: string } & Record<string, number | string>
export type SceneDatum = BinDatum & { scene_id: string }

// ---- Series configs ---------------------------------------------------------------------------

function VesselSwatch() {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: MODEL_FILL.vessel }} />
}

/** Model detections by predicted class. Vessels are split blue/orange, as on the map. */
export const modelChartConfig = {
  vessel: { label: 'Vessel', color: MODEL_HEX.vessel, icon: VesselSwatch },
  non_vessel: { label: 'Fixed object', color: MODEL_HEX.non_vessel },
} satisfies ChartConfig

/** Both mode: each category split into found (solid) and missed (hollow, as on the map). */
export const foundChartConfig: ChartConfig = {
  ...Object.fromEntries(
    CATEGORIES.flatMap((c): [string, ChartConfig[string]][] => {
      const Hollow = () => (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-[2px] border-[1.5px]"
          style={{ borderColor: CATEGORY_HEX[c], background: `${CATEGORY_HEX[c]}33` }}
        />
      )
      return [
        [`${c}_found`, { label: `${CATEGORY_SHORT[c]} found`, color: CATEGORY_HEX[c] }],
        [`${c}_missed`, { label: `${CATEGORY_SHORT[c]} missed`, color: CATEGORY_HEX[c], icon: Hollow }],
      ]
    }),
  ),
  extra: { label: 'No label', color: 'var(--muted-foreground)' },
}

export const foundKeys = (cats: Category[]) => cats.flatMap((c) => [`${c}_found`, `${c}_missed`])

export { chartConfig as labelChartConfig }

// ---- Bars -------------------------------------------------------------------------------------

/** Fill and stroke for one series. Model vessels get the split gradient, missed labels a hollow look. */
function barStyle(key: string, gradientId: string) {
  if (key === 'vessel') return { fill: `url(#${gradientId})` }
  const missed = key.match(/^(ais|dark|fixed)_missed$/)
  if (missed) {
    const hex = CATEGORY_HEX[missed[1] as Category]
    return { fill: `${hex}33`, stroke: hex, strokeWidth: 1 }
  }
  return { fill: `var(--color-${key})` }
}

function VesselGradient({ id, vertical }: { id: string; vertical: boolean }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2={vertical ? '0' : '1'} y2={vertical ? '1' : '0'}>
        <stop offset="50%" stopColor={CATEGORY_HEX.ais} />
        <stop offset="50%" stopColor={CATEGORY_HEX.dark} />
      </linearGradient>
    </defs>
  )
}

const legend = <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-3 gap-y-1" />} />

/** Stacked histogram, one stack per bin. */
export function StackedHistogram({ data, keys, config }: { data: BinDatum[]; keys: string[]; config: ChartConfig }) {
  const gid = `g${useId().replace(/:/g, '')}`
  return (
    <ChartContainer config={config} className="aspect-auto h-44 w-full [&_*]:outline-none">
      <BarChart data={data} margin={{ left: -16, right: 4, top: 4 }}>
        <VesselGradient id={gid} vertical={false} />
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} interval="preserveStartEnd" />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent />} />
        {legend}
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId="a" {...barStyle(k, gid)} radius={i === keys.length - 1 ? [3, 3, 0, 0] : 0} />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

/** One horizontal stacked bar per scene; click a bar to focus that scene. */
export function SceneBars({
  data,
  keys,
  config,
  active,
  onSelect,
}: {
  data: SceneDatum[]
  keys: string[]
  config: ChartConfig
  active: string | null
  onSelect: (sceneId: string) => void
}) {
  const gid = `g${useId().replace(/:/g, '')}`
  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full [&_*]:outline-none"
      style={{ height: data.length * 24 + 56 }}
    >
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8 }} barCategoryGap={4}>
        <VesselGradient id={gid} vertical />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={128}
          tickLine={false}
          axisLine={false}
          interval={0}
          tick={({ x, y, payload }) => (
            <text x={x} y={y} dy={4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {payload.value}
            </text>
          )}
        />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent />} />
        {legend}
        {keys.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="a"
            {...barStyle(k, gid)}
            radius={i === keys.length - 1 ? [0, 3, 3, 0] : 0}
            className="cursor-pointer"
            onClick={(d) => onSelect((d.payload as SceneDatum).scene_id)}
          >
            {data.map((d) => (
              <Cell key={d.scene_id} fillOpacity={!active || active === d.scene_id ? 1 : 0.3} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  )
}
