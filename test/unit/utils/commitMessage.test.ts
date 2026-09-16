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

describe('generateCommitMessage', () => {
  it('rejects when AI is not configured', async () => {
    await expect(generateCommitMessage([{ status: 'M', path: 'a.md' }])).rejects.toThrow('AI is not configured')
  })

  it('collects streamed tokens into a sanitized message', async () => {
    useAiSettings.setState({ provider: 'opencode-go', model: 'model-x', savedProviders: ['opencode-go'], baseUrls: {} })
    ipc.handlers.set('ask_ai', () => {
      emit('ai:token', 'fix(editor): ')
      emit('ai:token', 'guard empty selection')
      return undefined
    })

    await expect(generateCommitMessage([{ status: 'M', path: 'a.md' }]))
      .resolves.toBe('Auto commit : fix(editor): guard empty selection')
  })
})

describe('autoCommitMessage', () => {
  it('falls back to the deterministic message when AI is unconfigured', async () => {
    await expect(autoCommitMessage('.M notes/a.md', 'a.md')).resolves.toBe('Auto commit : update a.md')
  })

  it('uses the AI message when the provider is configured', async () => {
    useAiSettings.setState({ provider: 'opencode-go', model: 'model-x', savedProviders: ['opencode-go'], baseUrls: {} })
    ipc.handlers.set('ask_ai', () => {
      emit('ai:token', 'feat(notes): add backlinks')
      return undefined
    })

    await expect(autoCommitMessage('.M notes/a.md')).resolves.toBe('Auto commit : feat(notes): add backlinks')
  })
})
