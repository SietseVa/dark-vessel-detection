import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Workspace from './Workspace.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Workspace />
    </TooltipProvider>
  </StrictMode>,
)
