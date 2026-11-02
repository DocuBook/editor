import { useEffect, useState } from 'react'
import { ASCII_LOADER_FRAMES, type AsciiLoaderKind } from './asciiLoaderFrames'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Text spinner for the AI status line. It owns its frame state, so a tick
 *  re-renders this span alone, never the composer around it. Reduced motion
 *  shows the kind's first frame without ticking. Decorative: the label next to
 *  it is what assistive tech reads. */
export function AsciiLoader({ kind, className = '' }: { kind: AsciiLoaderKind; className?: string }) {
  const { frames, interval } = ASCII_LOADER_FRAMES[kind]
  /** The frame belongs to the kind it was counted for: a new kind starts from
   *  its first frame without a reset render. */
  const [tick, setTick] = useState({ kind, frame: 0 })
  const frame = tick.kind === kind ? tick.frame : 0
  useEffect(() => {
    if (prefersReducedMotion()) return
    const timer = setInterval(() => setTick(previous => ({
      kind,
      frame: ((previous.kind === kind ? previous.frame : 0) + 1) % frames.length,
    })), interval)
    return () => clearInterval(timer)
  }, [kind, frames.length, interval])
  return (
    <span
      aria-hidden="true"
      data-kind={kind}
      className={`ai-ascii-loader inline-block w-[5ch] shrink-0 whitespace-pre font-mono text-xs leading-none ${className}`}
    >
      {frames[frame]}
    </span>
  )
}
