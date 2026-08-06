import { useEffect, useRef } from 'react'

/**
 * Calls `fn` immediately, then every `ms` milliseconds.
 * Uses a ref internally so `fn` doesn't need to be stable.
 */
export function usePolling(fn: () => void, ms: number) {
  const saved = useRef(fn)
  saved.current = fn

  useEffect(() => {
    saved.current()
    const id = setInterval(() => saved.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}
