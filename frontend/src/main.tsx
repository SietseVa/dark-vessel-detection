import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SarWorkspace from './sar/Workspace.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'

// #sar and #sar-yolo-tiles show the SAR monitor ported from the codex/sar-yolo-tiles branch.
const isSar = () => window.location.hash.startsWith('#sar')

function Root() {
  const [sar, setSar] = useState(isSar)
  useEffect(() => {
    const change = () => setSar(isSar())
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  return sar ? <SarWorkspace /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Root />
    </TooltipProvider>
  </StrictMode>,
)
