import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (args?: Record<string, unknown>) => unknown>(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}))

vi.mock('../../../frontend/lib/ipc', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    const handler = ipc.handlers.get(cmd)
    if (!handler) throw new Error(`no handler for ${cmd}`)
    return Promise.resolve(handler(args))
  },
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    if (!ipc.listeners.has(event)) ipc.listeners.set(event, new Set())
    ipc.listeners.get(event)!.add(cb)
    return Promise.resolve(() => { ipc.listeners.get(event)!.delete(cb) })
  },
}))

import {
  autoCommitMessage,
  fallbackCommitMessage,
  generateCommitMessage,
  parseCommitFiles,
  sanitizeCommitMessage,
} from '../../../frontend/utils/commitMessage'
import { useAiSettings } from '../../../frontend/stores/aiSettings'

function emit(event: string, payload: unknown) {
  ipc.listeners.get(event)?.forEach(cb => cb({ payload }))
}

/** Emit a token the way the backend does — tagged with the request that asked
 *  for it. `ask_ai` args carry the id, so tests exercise the same filter the
 *  real transport uses instead of a payload shape that no longer exists. */
function emitToken(requestId: unknown, token: string) {
  emit('ai:token', { requestId: String(requestId ?? ''), token })
}

beforeEach(() => {
  ipc.handlers.clear()
  ipc.listeners.clear()
  useAiSettings.setState({ provider: '', model: '', savedProviders: [], baseUrls: {} })
})

describe('parseCommitFiles', () => {
  it('prefers staged entries over worktree changes', () => {
    const files = parseCommitFiles('M. a.md\n.M b.md\n?? c.md')
    expect(files).toEqual([{ status: 'M', path: 'a.md' }])
  })

  it('falls back to worktree changes when nothing is staged', () => {
    const files = parseCommitFiles('.M a.md\n D b.md')
    expect(files).toEqual([
      { status: 'M', path: 'a.md' },
      { status: 'D', path: 'b.md' },
    ])
  })

  it('maps untracked files to an addition', () => {
    expect(parseCommitFiles('?? new.md')).toEqual([{ status: 'A', path: 'new.md' }])
  })

  it('returns nothing for an empty status', () => {
    expect(parseCommitFiles('   ')).toEqual([])
  })
})

describe('sanitizeCommitMessage', () => {
  it('strips code fences and ignores body lines', () => {
    const raw = '```\nfeat(core): add thing\n\n- one\n- two\n```'
    expect(sanitizeCommitMessage(raw)).toBe('Auto commit : feat(core): add thing')
  })

  it('drops body content and clamps the subject to 100 chars', () => {
    const raw = `feat: ${'x'.repeat(150)}\nHere is why:\n- ignored\nnot a bullet`
    const output = sanitizeCommitMessage(raw)
    expect(output.length).toBe(100)
    expect(output).not.toContain('ignored')
    expect(output).not.toContain('not a bullet')
  })

  it('returns an empty string when there is no content', () => {
    expect(sanitizeCommitMessage('   \n  ')).toBe('')
  })
})

describe('fallbackCommitMessage', () => {
  it('summarises several markdown files with a single subject', () => {
    const files = [
      { status: 'M', path: 'notes/a.md' },
      { status: 'M', path: 'notes/b.md' },
    ]
    expect(fallbackCommitMessage(files)).toBe('Auto commit : update 2 files')
  })

  it('names a single file instead of the generic word "changes"', () => {
    expect(fallbackCommitMessage([{ status: 'A', path: 'notes/new.md' }])).toBe('Auto commit : update new.md')
  })

  it('uses the active tab name for an empty change set', () => {
    expect(fallbackCommitMessage([], 'active.md')).toBe('Auto commit : update active.md')
    expect(fallbackCommitMessage([])).toBe('Auto commit : update vault')
  })
})

/** Provider settings that make `getAiConfig` resolve to a saved provider. */
function configureAi() {
  useAiSettings.setState({ provider: 'opencode-go', model: 'model-x', savedProviders: ['opencode-go'], baseUrls: {} })
}

describe('generateCommitMessage', () => {
  it('rejects when AI is not configured', async () => {
    await expect(generateCommitMessage([{ status: 'M', path: 'a.md' }])).rejects.toThrow('AI is not configured')
  })

  it('collects streamed tokens into a sanitized message', async () => {
    configureAi()
    ipc.handlers.set('ask_ai', args => {
      emitToken(args?.requestId, 'fix(editor): ')
      emitToken(args?.requestId, 'guard empty selection')
      return undefined
    })

    await expect(generateCommitMessage([{ status: 'M', path: 'a.md' }]))
      .resolves.toBe('Auto commit : fix(editor): guard empty selection')
  })

  it('ignores tokens belonging to another request', async () => {
    // Regression: `ai:token` is shared, so a concurrent AI panel turn used to
    // bleed its tokens into the commit subject.
    configureAi()
    ipc.handlers.set('ask_ai', args => {
      emitToken('someone-else', 'WRONG ')
      emitToken(args?.requestId, 'notes: add backlinks')
      return undefined
    })

    await expect(generateCommitMessage([{ status: 'M', path: 'a.md' }]))
      .resolves.toBe('Auto commit : notes: add backlinks')
  })

  it('prompts the model with every changed file and the diff excerpt', async () => {
    configureAi()
    let prompt = ''
    ipc.handlers.set('ask_ai', args => {
      const messages = JSON.parse(String(args?.messages)) as { role: string; content: string }[]
      prompt = messages[1].content
      emitToken(args?.requestId, 'notes: add backlinks')
      return undefined
    })

    await generateCommitMessage(
      [{ status: 'M', path: 'notes/a.md' }, { status: 'A', path: 'notes/b.md' }],
      async () => 'notes/a.md (+4 -1)\n  + hello',
    )

    expect(prompt).toContain('- M notes/a.md')
    expect(prompt).toContain('- A notes/b.md')
    expect(prompt).toContain('notes/a.md (+4 -1)')
    expect(prompt).toContain('+ hello')
  })

  it('still answers when the diff loader fails', async () => {
    configureAi()
    ipc.handlers.set('ask_ai', args => {
      emitToken(args?.requestId, 'notes: add backlinks')
      return undefined
    })

    await expect(generateCommitMessage(
      [{ status: 'M', path: 'a.md' }, { status: 'M', path: 'b.md' }],
      async () => { throw new Error('diff unavailable') },
    )).resolves.toBe('Auto commit : notes: add backlinks')
  })
})

describe('autoCommitMessage', () => {
  it('names a single file without asking the model or the diff', async () => {
    let asked = false
    ipc.handlers.set('ask_ai', () => { asked = true; return undefined })

    await expect(autoCommitMessage('.M notes/a.md', 'a.md', async () => { asked = true; return '' }))
      .resolves.toBe('Auto commit : update a.md')
    expect(asked).toBe(false)
  })

  it('falls back for an empty change set', async () => {
    await expect(autoCommitMessage('   ', 'active.md')).resolves.toBe('Auto commit : update active.md')
  })

  it('falls back to the deterministic message when AI is unconfigured', async () => {
    await expect(autoCommitMessage('.M notes/a.md\n.M notes/b.md')).resolves.toBe('Auto commit : update 2 files')
  })

  it('uses the AI message when the provider is configured', async () => {
    configureAi()
    ipc.handlers.set('ask_ai', args => {
      emitToken(args?.requestId, 'add backlinks across notes')
      return undefined
    })

    await expect(autoCommitMessage('.M notes/a.md\n.M notes/b.md')).resolves.toBe('Auto commit : add backlinks across notes')
  })

  it('falls back when the AI stream returns nothing usable', async () => {
    configureAi()
    ipc.handlers.set('ask_ai', () => undefined)

    await expect(autoCommitMessage('.M notes/a.md\n.M notes/b.md')).resolves.toBe('Auto commit : update 2 files')
  })
})
