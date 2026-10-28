import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
/** Mantine's styles are imported by index.css, inside the cascade layer order it
 *  declares — see the top of that file. */
import './index.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorHandlers } from './utils/logger'
import './stores/theme' // applies <html data-theme> before first paint
import { installIteratorFilterPolyfill } from './utils/iteratorPolyfill'
installIteratorFilterPolyfill()
installGlobalErrorHandlers()

// NOTE: no Object.prototype hardening here. Tauri's freezePrototype broke
// zod and related dependencies (they assign Object.prototype.toString during
// module eval), and freezing __proto__ breaks rope-sequence (ProseMirror dep,
// does `Child.__proto__ = Parent` inheritance) — so any Object.prototype
// mutation kills the editor stack. Prototype-pollution protection belongs at
// input boundaries (JSON.parse reviver), not on built-in prototypes.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider>
      <ErrorBoundary><App /></ErrorBoundary>
    </MantineProvider>
  </React.StrictMode>,
)
