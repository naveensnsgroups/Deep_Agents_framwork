import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { TokenGate } from './components/auth/TokenGate.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenGate>
      <App />
    </TokenGate>
  </StrictMode>,
)
