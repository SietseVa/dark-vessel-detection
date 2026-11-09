import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { chartConfig, fmtDay, fmtPass, pct } from '@/theme'

export interface Split {
  key: string
  label: string
  dark: number
  ais: number
}

const stacks = (radius: [number, number, number, number]) =>
  (['dark', 'ais'] as const).map((k, i) => (
    <Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} radius={i === 1 ? radius : 0} />
  ))

const shareFooter = (items: readonly { payload?: unknown }[] | undefined) => {
  const p = items?.[0]?.payload as Split | undefined
  return p ? `${pct(p.dark, p.dark + p.ais)} dark` : ''
}

/** Detections per day, dark vs matched. */
export function DailyChart({ data }: { data: Split[] }) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full [&_*]:outline-none">
      <BarChart data={data} margin={{ left: -12, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="key"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
          tickFormatter={(d: string) => fmtDay(d)}
        />
        <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <ChartTooltip
          cursor={{ fillOpacity: 0.4 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => {
                const p = items?.[0]?.payload as Split | undefined
                return p ? `${fmtDay(p.key)} · ${shareFooter(items)}` : ''
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {stacks([2, 2, 0, 0])}
      </BarChart>
    </ChartContainer>
  )
}

/** Horizontal bars per EEZ; click to filter. */
export function WatersChart({
  data,
  active,
  onSelect,
}: {
  data: Split[]
  active: string
  onSelect: (code: string) => void
}) {
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full [&_*]:outline-none"
      style={{ height: data.length * 26 + 40 }}
    >
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8 }} barCategoryGap={5}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={112}
          tickLine={false}
          axisLine={false}
          interval={0}
          tick={({ x, y, payload }) => (
            <text x={x} y={y} dy={4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {payload.value}
            </text>
          )}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.4 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => {
                const p = items?.[0]?.payload as Split | undefined
                return p ? `${p.label} · ${shareFooter(items)}` : ''
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {(['dark', 'ais'] as const).map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="a"
            fill={`var(--color-${k})`}
            radius={i === 1 ? [0, 2, 2, 0] : 0}
            className="cursor-pointer"
            onClick={(d) => onSelect((d.payload as Split).key)}
          >
            {data.map((d) => (
              <Cell key={d.key} fillOpacity={active === 'ALL' || active === d.key ? 1 : 0.3} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  )
}

/** One bar per satellite pass; click a bar to show only that pass on the map. */
export function PassTimeline({
  data,
  selected,
  onSelect,
}: {
  data: Split[]
  selected: string | null
  onSelect: (ts: string | null) => void
}) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-24 w-full [&_*]:outline-none">
      <BarChart
        data={data}
        margin={{ left: 0, right: 0, top: 4, bottom: 0 }}
        barCategoryGap={1}
        className="cursor-pointer"
        onClick={(state) => {
          // the bars are thin, so select whichever pass is under the cursor
          const ts = state?.activeLabel != null ? String(state.activeLabel) : null
          if (ts) onSelect(selected === ts ? null : ts)
        }}
      >
        <XAxis
          dataKey="key"
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          minTickGap={40}
          tickFormatter={(ts: string) => fmtDay(ts)}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.3 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => {
                const p = items?.[0]?.payload as Split | undefined
                return p ? `${fmtPass(p.key)} · ${shareFooter(items)}` : ''
              }}
            />
          }
        />
        {(['dark', 'ais'] as const).map((k) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="a"
            fill={`var(--color-${k})`}
          >
            {data.map((d) => (
              <Cell key={d.key} fillOpacity={!selected || selected === d.key ? 1 : 0.25} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  )
}
