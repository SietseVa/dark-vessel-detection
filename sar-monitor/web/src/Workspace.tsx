import { useEffect, useState } from 'react'
import App from './App'
import { YoloTiles } from './components/YoloTiles'

const PAGES = [
  { hash: '#monitor', label: 'SAR monitor' },
  { hash: '#yolo-tiles', label: 'YOLO tiles' },
]
const current = () => PAGES.find((p) => p.hash === window.location.hash)?.hash ?? '#monitor'

export default function Workspace() {
  const [page, setPage] = useState(current)
  useEffect(() => {
    const change = () => setPage(current())
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  return (
    <div className="flex h-svh flex-col">
      <nav aria-label="Workspace pages" className="flex h-12 shrink-0 items-center gap-5 border-b bg-background px-5 text-sm">
        {PAGES.map((p) => (
          <a
            key={p.hash}
            href={p.hash}
            aria-current={page === p.hash ? 'page' : undefined}
            className={page === p.hash ? 'font-semibold' : 'text-muted-foreground'}
          >
            {p.label}
          </a>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {page === '#yolo-tiles' ? <YoloTiles /> : <App />}
      </div>
    </div>
  )
}
