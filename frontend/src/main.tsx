import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // No tracing/profiling — errors only.
    tracesSampleRate: 0,
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {dsn ? (
      <Sentry.ErrorBoundary fallback={<div style={{ padding: 24, fontFamily: 'monospace' }}>something broke — refresh to try again</div>}>
        <App />
      </Sentry.ErrorBoundary>
    ) : (
      <App />
    )}
  </StrictMode>,
)
