import type { Category } from '@/api'
import { CATEGORY_HEX } from '@/theme'
import { cn } from '@/lib/utils'

export function Swatch({ category, className }: { category: Category; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-full', className)}
      style={{ background: CATEGORY_HEX[category] }}
    />
  )
}
