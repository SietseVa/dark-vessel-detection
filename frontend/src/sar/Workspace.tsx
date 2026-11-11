import { useEffect, useState } from 'react'
import App from './App'
import { YoloTiles } from './components/YoloTiles'

export default function Workspace() {
  const [page, setPage] = useState(window.location.hash === '#sar-yolo-tiles' ? 'yolo' : 'monitor')
  useEffect(() => {
    const change = () => setPage(window.location.hash === '#sar-yolo-tiles' ? 'yolo' : 'monitor')
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  return <div className="flex h-svh flex-col"><nav aria-label="Workspace pages" className="flex h-12 shrink-0 items-center gap-5 border-b bg-background px-5 text-sm"><a href="#sar" aria-current={page === 'monitor' ? 'page' : undefined} className={page === 'monitor' ? 'font-semibold' : 'text-muted-foreground'}>SAR monitor</a><a href="#sar-yolo-tiles" aria-current={page === 'yolo' ? 'page' : undefined} className={page === 'yolo' ? 'font-semibold' : 'text-muted-foreground'}>YOLO tiles</a><a href="#" className="ml-auto text-muted-foreground hover:text-foreground">← Training data</a></nav><div className="min-h-0 flex-1">{page === 'yolo' ? <YoloTiles /> : <App />}</div></div>
}
