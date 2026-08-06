import { useEffect } from 'react'

/**
 * Registers a global `keydown` listener that is cleaned up on unmount.
 */
export function useKeyboard(handler: (e: KeyboardEvent) => void) {
  useEffect(() => {
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handler])
}
