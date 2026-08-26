import { createRoot } from 'react-dom/client'
import VaultPicker from '../components/VaultPicker'

/** Web-only vault picker launcher. Keeps DOM mounting outside the component file. */
export function pickServerVault(): Promise<string | null> {
  return new Promise(resolve => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;z-index:9999'
    document.body.appendChild(host)
    const root = createRoot(host)
    const close = (path: string | null) => { root.unmount(); host.remove(); resolve(path) }
    root.render(<VaultPicker onPick={close} />)
  })
}
