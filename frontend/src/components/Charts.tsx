import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import type { Category } from '@/api'
import { chartConfig } from '@/theme'

export type BinDatum = { label: string } & Partial<Record<Category, number>>
export type SceneDatum = { label: string; scene_id: string } & Record<Category, number>

/** Stacked histogram (vessels with vs without AIS). */
export function StackedHistogram({ data, cats }: { data: BinDatum[]; cats: Category[] }) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full [&_*]:outline-none">
      <BarChart data={data} margin={{ left: -16, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} interval="preserveStartEnd" />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {cats.map((c, i) => (
          <Bar
            key={c}
            dataKey={c}
            stackId="a"
            fill={`var(--color-${c})`}
            radius={i === cats.length - 1 ? [3, 3, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

/** One horizontal stacked bar per scene; click a bar to focus that scene. */
export function SceneBars({
  data,
  cats,
  active,
  onSelect,
}: {
  data: SceneDatum[]
  cats: Category[]
  active: string | null
  onSelect: (sceneId: string) => void
}) {
  return (
    <ChartContainer config={chartConfig} className="aspect-auto w-full [&_*]:outline-none" style={{ height: data.length * 24 + 40 }}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8 }} barCategoryGap={4}>
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
        <ChartLegend content={<ChartLegendContent />} />
        {cats.map((c, i) => (
          <Bar
            key={c}
            dataKey={c}
            stackId="a"
            fill={`var(--color-${c})`}
            radius={i === cats.length - 1 ? [0, 3, 3, 0] : 0}
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
