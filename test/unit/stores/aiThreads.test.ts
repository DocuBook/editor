import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Zustand's persist middleware reads `window.localStorage` and warns
 *  ("storage is currently unavailable") in vitest's node environment, where
 *  neither exists. Back it with an in-memory store so writes succeed and
 *  assertions stay deterministic. */
vi.hoisted(() => {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() { return map.size },
    clear: () => { map.clear() },
    getItem: key => map.get(key) ?? null,
    key: index => Array.from(map.keys())[index] ?? null,
    removeItem: key => { map.delete(key) },
    setItem: (key, value) => { map.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
})

import { useAiThreads } from '../../../frontend/stores/aiThreads'

const state = () => useAiThreads.getState()

/** beginExchange returns null for blank prompts; tests that expect a started
 *  exchange use this to fail loudly instead of dereferencing null. */
const begin = (prompt: string, filePath?: string) => {
  const exchange = state().beginExchange(prompt, filePath)
  if (!exchange) throw new Error(`expected an exchange for ${JSON.stringify(prompt)}`)
  return exchange
}

describe('AI document threads', () => {
  beforeEach(() => {
    localStorage.clear()
    useAiThreads.setState({ threads: [], activeThreadId: null })
  })

  describe('one thread per document', () => {
    it('reuses the thread for a file and preserves the first prompt as its title', () => {
      begin('First prompt', 'notes/report.md')
      begin('Second prompt', 'notes/report.md')

      const { threads } = state()
      expect(threads).toHaveLength(1)
      expect(threads[0].title).toBe('First prompt')
      expect(threads[0].filePath).toBe('notes/report.md')
      expect(threads[0].messages).toHaveLength(4)
      expect(threads[0].messages.map(message => message.content)).toEqual([
        'First prompt', '', 'Second prompt', '',
      ])
    })

    it('starts a separate thread for each file path', () => {
      begin('Alpha', 'a.md')
      begin('Beta', 'b.md')

      const { threads } = state()
      expect(threads).toHaveLength(2)
      expect(threads.map(thread => thread.filePath)).toEqual(['b.md', 'a.md'])
    })

    it('keeps the prompt title while remapping a renamed document', () => {
      begin('Summarize this document', 'notes/old.md')
      state().renamePath('notes/old.md', 'notes/renamed.md')
      begin('Rewrite the introduction', 'notes/renamed.md')

      const { threads } = state()
      expect(threads).toHaveLength(1)
      expect(threads[0].title).toBe('Summarize this document')
      expect(threads[0].filePath).toBe('notes/renamed.md')
      expect(threads[0].messages).toHaveLength(4)
    })
  })

  describe('renamePath remapping', () => {
    it('remaps document threads below a renamed folder', () => {
      begin('Review this draft', 'drafts/chapter/one.md')
      state().renamePath('drafts', 'archive')

      expect(state().threads[0].filePath).toBe('archive/chapter/one.md')
    })

    it('remaps nested descendants to the new root', () => {
      begin('Nested', 'drafts/chapter/one.md')
      state().renamePath('drafts/chapter', 'drafts/book')

      expect(state().threads[0].filePath).toBe('drafts/book/one.md')
    })

    it('leaves paths that only share a name prefix untouched', () => {
      begin('Sibling', 'notes-old/report.md')
      begin('Target', 'notes/report.md')
      state().renamePath('notes', 'archive')

      expect(state().threads.map(thread => thread.filePath)).toEqual([
        'archive/report.md',
        'notes-old/report.md',
      ])
    })

    it('renames the exact document without touching its former siblings', () => {
      begin('Target', 'notes/old.md')
      begin('Keep', 'notes/keep.md')
      state().renamePath('notes/old.md', 'notes/new.md')

      expect(state().threads.find(thread => thread.title === 'Target')?.filePath).toBe('notes/new.md')
      expect(state().threads.find(thread => thread.title === 'Keep')?.filePath).toBe('notes/keep.md')
    })
  })

  describe('active thread selection', () => {
    it('activates the thread it just created', () => {
      const { threadId } = begin('Hello', 'a.md')

      expect(state().activeThreadId).toBe(threadId)
      expect(state().threads[0].id).toBe(threadId)
    })

    it('accepts null to collapse and ignores unknown ids', () => {
      const { threadId } = begin('Hello', 'a.md')

      state().setActiveThread(null)
      expect(state().activeThreadId).toBeNull()

      state().setActiveThread(threadId)
      expect(state().activeThreadId).toBe(threadId)

      state().setActiveThread('does-not-exist')
      expect(state().activeThreadId).toBe(threadId)
    })

    it('promotes the newest remaining thread when the active one is deleted', () => {
      begin('Alpha', 'a.md')
      const beta = begin('Beta', 'b.md')
      expect(state().activeThreadId).toBe(beta.threadId)

      state().removeThread(beta.threadId)

      expect(state().threads).toHaveLength(1)
      expect(state().activeThreadId).toBe(state().threads[0].id)
    })

    it('keeps the active thread when a different one is deleted', () => {
      const alpha = begin('Alpha', 'a.md')
      begin('Beta', 'b.md')
      state().setActiveThread(alpha.threadId)

      state().removeThread(state().threads[0].id)

      expect(state().activeThreadId).toBe(alpha.threadId)
      expect(state().threads).toHaveLength(1)
    })

    it('clears threads and the active id together', () => {
      begin('Alpha', 'a.md')
      state().clearThreads()

      expect(state().threads).toEqual([])
      expect(state().activeThreadId).toBeNull()
    })
  })

  describe('exchange lifecycle', () => {
    it('caps retained messages per thread', () => {
      for (let index = 0; index < 101; index++) begin(`prompt ${index}`, 'a.md')

      const [thread] = state().threads
      expect(thread.messages).toHaveLength(200)
      expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'prompt 1' })
      expect(thread.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'streaming', content: '' })
      expect(thread.title).toBe('prompt 0')
    })

    it('drops the oldest thread past the thread cap', () => {
      for (let index = 0; index < 51; index++) begin(`t${index}`, `file-${index}.md`)

      const { threads } = state()
      expect(threads).toHaveLength(50)
      expect(threads[0].filePath).toBe('file-50.md')
      expect(threads.some(thread => thread.filePath === 'file-0.md')).toBe(false)
    })

    it('caps derived titles and collapses whitespace', () => {
      begin('x'.repeat(80), 'long.md')
      begin('  Summarize\n\n\tthis   document  ', 'spaced.md')

      expect(state().threads.find(thread => thread.filePath === 'long.md')?.title).toBe('x'.repeat(60))
      expect(state().threads.find(thread => thread.filePath === 'spaced.md')?.title).toBe('Summarize this document')
    })

    it('streams then finishes an assistant message', () => {
      const { threadId, assistantId } = begin('Explain', 'a.md')
      const streaming = state().threads[0].messages.at(-1)
      expect(streaming).toMatchObject({ id: assistantId, role: 'assistant', status: 'streaming', content: '' })

      state().setMessageContent(threadId, assistantId, 'Hello')
      expect(state().threads[0].messages.at(-1)).toMatchObject({ status: 'streaming', content: 'Hello' })

      state().finishMessage(threadId, assistantId, 'done')
      expect(state().threads[0].messages.at(-1)).toMatchObject({ status: 'done', content: 'Hello' })
    })

    it('keeps existing content when finishMessage omits it, and can override it', () => {
      const { threadId, assistantId } = begin('Explain', 'a.md')
      state().setMessageContent(threadId, assistantId, 'partial')

      state().finishMessage(threadId, assistantId, 'done')
      expect(state().threads[0].messages.at(-1)).toMatchObject({ status: 'done', content: 'partial' })

      state().finishMessage(threadId, assistantId, 'error', 'boom')
      expect(state().threads[0].messages.at(-1)).toMatchObject({ status: 'error', content: 'boom' })
    })

    it('is a no-op for unknown threads and message ids', () => {
      const { threadId, assistantId } = begin('Explain', 'a.md')
      const before = state().threads[0].messages

      expect(() => state().setMessageContent('missing-thread', assistantId, 'x')).not.toThrow()
      expect(() => state().setMessageContent(threadId, 'missing-message', 'x')).not.toThrow()
      expect(() => state().finishMessage('missing-thread', assistantId, 'done')).not.toThrow()
      expect(state().threads[0].messages).toEqual(before)
    })
  })

  describe('guards', () => {
    it('ignores blank prompts without disturbing existing state', () => {
      const { threadId } = begin('Keep me', 'a.md')

      expect(state().beginExchange('', 'b.md')).toBeNull()
      expect(state().beginExchange('   \n\t ', 'b.md')).toBeNull()
      expect(state().threads).toHaveLength(1)
      expect(state().activeThreadId).toBe(threadId)
    })

    it('starts an unbound thread when no file path is given', () => {
      const { threadId } = begin('Unbound prompt')

      expect(state().threads).toHaveLength(1)
      expect(state().threads[0].filePath).toBe('')
      expect(state().activeThreadId).toBe(threadId)
    })

    it('continues the active unbound thread when no file path is given', () => {
      const { threadId } = begin('First')
      begin('Second')

      expect(state().threads).toHaveLength(1)
      expect(state().threads[0].id).toBe(threadId)
      expect(state().threads[0].messages).toHaveLength(4)
    })

    it('does not reuse an unbound active thread for a file-scoped prompt', () => {
      begin('Unbound')
      const scoped = begin('Scoped', 'a.md')

      expect(state().threads).toHaveLength(2)
      expect(state().activeThreadId).toBe(scoped.threadId)
      expect(state().threads.find(thread => thread.id === scoped.threadId)?.filePath).toBe('a.md')
    })
  })
})
