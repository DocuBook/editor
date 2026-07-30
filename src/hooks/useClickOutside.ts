import { useEffect, useRef, type RefObject } from 'react'

/**
 * Calls `callback` when a mousedown event occurs outside `ref`.
 */
export function useClickOutside(ref: RefObject<HTMLElement | null>, callback: () => void) {
  const cb = useRef(callback)
  cb.current = callback

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current()
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [ref])
}
