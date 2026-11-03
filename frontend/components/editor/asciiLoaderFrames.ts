import type { AiPhase } from '../../utils/aiExtension'

/** What the AI status line is animating: a `thinking` phase, or the two output
 *  states. */
export type AsciiLoaderKind = AiPhase | 'generating' | 'ai-writing'

/** One animation per kind, so the loader itself tells waiting, reasoning,
 *  reading sources, re-asking and producing output apart. Every frame of every
 *  kind is one bracketed cell of the same width: switching kinds never shifts
 *  the label beside it, and a short glyph does not leave a gap before it. The
 *  first frame is what reduced motion shows, so it is never an empty cell. */
export const ASCII_LOADER_FRAMES: Record<AsciiLoaderKind, { frames: string[]; interval: number }> = {
  thinking: { frames: ['[ | ]', '[ / ]', '[ - ]', '[ \\ ]'], interval: 120 },
  reasoning: { frames: ['[...]', '[ ..]', '[  .]', '[   ]', '[.  ]', '[.. ]'], interval: 150 },
  researching: { frames: ['[*  ]', '[ * ]', '[  *]', '[ * ]'], interval: 130 },
  retrying: { frames: ['[<<<]', '[<< ]', '[<  ]', '[   ]', '[  <]', '[ <<]'], interval: 110 },
  /** `≈` is the one glyph outside ASCII: a wave reads as output flowing in.
   *  It draws as wide as the `=` it replaced, and the slot is a fixed 5ch, so
   *  the label beside it stays put either way. */
  generating: { frames: ['[≈≈≈]', '[ ≈≈]', '[  ≈]', '[   ]', '[≈  ]', '[≈≈ ]'], interval: 110 },
  'ai-writing': { frames: ['[_  ]', '[a_ ]', '[ab_]', '[abc]'], interval: 140 },
}
