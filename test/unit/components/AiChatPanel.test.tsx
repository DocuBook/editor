// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AiChatPanel from '../../../frontend/components/panels/AiChatPanel'
import { useAiThreads } from '../../../frontend/stores/aiThreads'
import type { AiThread, AiThreadMessage } from '../../../frontend/stores/aiThreads'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null = null

const message = (overrides: Partial<AiThreadMessage> = {}): AiThreadMessage => ({
  id: 'm1',
  role: 'user',
  content: 'Hello',
  status: 'done',
  createdAt: 1,
  ...overrides,
})

const thread = (overrides: Partial<AiThread> = {}): AiThread => ({
  id: 't1',
  title: 'Thread one',
  filePath: 'a.md',
  createdAt: 1,
  updatedAt: 1,
  messages: [message()],
  ...overrides,
})

const articles = () => Array.from(document.querySelectorAll<HTMLElement>('article'))

const articleTitled = (title: string) =>
  articles().find(article => article.textContent?.includes(title)) ?? null

const headerButton = (article: HTMLElement) =>
  article.querySelector<HTMLButtonElement>('button[aria-expanded]')!

const deleteButton = (article: HTMLElement) =>
  article.querySelector<HTMLButtonElement>('button[aria-label^="Delete thread"]')!

const render = () => act(() => { root!.render(<AiChatPanel />) })

const click = (element: Element) => act(() => { (element as HTMLElement).click() })

const setThreads = (threads: AiThread[], activeThreadId: string | null = null) =>
  act(() => { useAiThreads.setState({ threads, activeThreadId }) })

beforeEach(() => {
  localStorage.clear()
  useAiThreads.setState({ threads: [], activeThreadId: null })
  document.body.innerHTML = '<div id="root"></div>'
  // jsdom does not implement scrollIntoView; the panel calls it on the message list end.
  Element.prototype.scrollIntoView = vi.fn()
  root = createRoot(document.getElementById('root')!)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.restoreAllMocks()
})

describe('AiChatPanel', () => {
  it('shows an empty state and a zero count when there are no threads', () => {
    render()

    expect(document.body.textContent).toContain('Threads (0)')
    expect(document.body.textContent).toContain('No AI threads yet.')
    expect(articles()).toHaveLength(0)
  })

  it('counts only threads that have messages', () => {
    setThreads([
      thread({ id: 'legacy', title: 'Legacy empty', messages: [] }),
      thread({ id: 'real', title: 'Has messages' }),
    ])

    render()

    expect(document.body.textContent).toContain('Threads (1)')
    expect(document.body.textContent).toContain('Has messages')
    expect(document.body.textContent).not.toContain('Legacy empty')
    expect(articles()).toHaveLength(1)
  })

  it('leaves every thread collapsed while no thread is active', () => {
    setThreads([
      thread({ id: 't1', title: 'First' }),
      thread({ id: 't2', title: 'Second', updatedAt: 2 }),
    ], null)

    render()

    expect(articles()).toHaveLength(2)
    for (const article of articles()) {
      expect(headerButton(article).getAttribute('aria-expanded')).toBe('false')
    }
    expect(document.body.textContent).not.toContain('Prompt')
  })

  it('expands a thread to reveal its prompt and AI messages', () => {
    setThreads([thread({
      id: 't1',
      title: 'Explain the code',
      messages: [
        message({ id: 'u1', role: 'user', content: 'Explain the code' }),
        message({ id: 'a1', role: 'assistant', content: 'It is a store.' }),
      ],
    })])

    render()
    click(headerButton(articleTitled('Explain the code')!))

    const article = articleTitled('Explain the code')!
    expect(headerButton(article).getAttribute('aria-expanded')).toBe('true')
    expect(article.querySelector('#ai-thread-t1')).not.toBeNull()
    expect(article.textContent).toContain('Prompt')
    expect(article.textContent).toContain('AI')
    expect(article.textContent).toContain('Explain the code')
    expect(article.textContent).toContain('It is a store.')
  })

  it('collapses the expanded thread when its header is toggled again', () => {
    setThreads([thread({ id: 't1', title: 'Explain the code' })])

    render()
    const header = headerButton(articleTitled('Explain the code')!)
    click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')

    click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(articleTitled('Explain the code')!.querySelector('#ai-thread-t1')).toBeNull()
  })

  it('keeps a single thread expanded when another is opened', () => {
    setThreads([
      thread({ id: 't1', title: 'First' }),
      thread({ id: 't2', title: 'Second', updatedAt: 2 }),
    ])

    render()
    click(headerButton(articleTitled('First')!))
    expect(headerButton(articleTitled('First')!).getAttribute('aria-expanded')).toBe('true')

    click(headerButton(articleTitled('Second')!))
    expect(headerButton(articleTitled('Second')!).getAttribute('aria-expanded')).toBe('true')
    expect(headerButton(articleTitled('First')!).getAttribute('aria-expanded')).toBe('false')
    expect(useAiThreads.getState().activeThreadId).toBe('t2')
  })

  it('shows a thinking placeholder, then the streamed answer', () => {
    setThreads([thread({
      id: 't1',
      title: 'Streaming',
      messages: [message({ id: 'a1', role: 'assistant', content: '', status: 'streaming' })],
    })])

    render()
    click(headerButton(articleTitled('Streaming')!))
    expect(document.body.textContent).toContain('Thinking…')

    act(() => { useAiThreads.getState().setMessageContent('t1', 'a1', 'Streamed answer') })

    expect(document.body.textContent).toContain('Streamed answer')
    expect(document.body.textContent).not.toContain('Thinking…')
  })

  it('labels failed and empty finished messages', () => {
    setThreads([thread({
      id: 't1',
      title: 'Mixed statuses',
      messages: [
        message({ id: 'a1', role: 'assistant', content: '', status: 'error' }),
        message({ id: 'a2', role: 'assistant', content: '', status: 'done' }),
      ],
    })])

    render()
    click(headerButton(articleTitled('Mixed statuses')!))

    expect(document.body.textContent).toContain('Failed')
    expect(document.body.textContent).toContain('No response recorded')
  })

  it('deletes a collapsed thread from the list', () => {
    setThreads([
      thread({ id: 't1', title: 'First' }),
      thread({ id: 't2', title: 'Second', updatedAt: 2 }),
    ])

    render()
    click(deleteButton(articleTitled('First')!))

    expect(useAiThreads.getState().threads.map(item => item.id)).toEqual(['t2'])
    expect(document.body.textContent).not.toContain('First')
    expect(document.body.textContent).toContain('Threads (1)')
  })

  it('falls back to the empty state when the last active thread is deleted', () => {
    setThreads([thread({ id: 't1', title: 'Only thread' })], 't1')

    render()
    expect(headerButton(articleTitled('Only thread')!).getAttribute('aria-expanded')).toBe('true')

    click(deleteButton(articleTitled('Only thread')!))

    expect(useAiThreads.getState().threads).toEqual([])
    expect(document.body.textContent).toContain('Threads (0)')
    expect(document.body.textContent).toContain('No AI threads yet.')
  })

  it('orders threads by most recently updated', () => {
    setThreads([
      thread({ id: 'old', title: 'Older', updatedAt: 1 }),
      thread({ id: 'new', title: 'Newer', updatedAt: 5 }),
    ])

    render()

    expect(articles()[0].textContent).toContain('Newer')
    expect(articles()[1].textContent).toContain('Older')
  })
})
