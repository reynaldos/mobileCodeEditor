import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { registerServiceWorker } from './push.ts'
import './styles.css'

// Register early so the SW is active by the time the user taps Enable. No-ops
// where push is unsupported.
void registerServiceWorker()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
