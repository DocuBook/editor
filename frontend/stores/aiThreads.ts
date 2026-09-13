import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uuid } from '../utils/uuid'

export type AiMessageStatus = 'streaming' | 'done' | 'error'

export interface AiThreadMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: AiMessageStatus
  createdAt: number
}

export interface AiThread {
  id: string
  title: string
  filePath: string
  /** Absolute vault identity keeps histories isolated while surviving reopen. */
  vaultPath?: string
  createdAt: number
  updatedAt: number
  messages: AiThreadMessage[]
}

interface AiThreadsState {
  threads: AiThread[]
  activeThreadId: string | null
  setActiveThread: (id: string | null) => void
  renamePath: (fromPath: string, toPath: string) => void
  removeThread: (id: string) => void
  clearThreads: () => void
  updateLatestAssistantStatus: (threadId: string, status: string) => void
  beginExchange: (userText: string, filePath?: string, vaultPath?: string) => { threadId: string; assistantId: string } | null
  setMessageContent: (threadId: string, messageId: string, content: string) => void
  finishMessage: (threadId: string, messageId: string, status: AiMessageStatus, content?: string) => void
}

const MAX_THREADS = 50
const MAX_MESSAGES_PER_THREAD = 200
const MAX_TITLE_LENGTH = 60

const updateThread = (threads: AiThread[], id: string, update: (thread: AiThread) => AiThread) =>
  threads.map(thread => thread.id === id ? update(thread) : thread)

const titleFromPrompt = (prompt: string) => {
  const title = prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
  return title || 'New chat'
}

export const useAiThreads = create<AiThreadsState>()(
  persist(
    (set, get) => ({
      threads: [],
      activeThreadId: null,

      setActiveThread: (id) => {
        if (id === null || get().threads.some(thread => thread.id === id)) set({ activeThreadId: id })
      },

      renamePath: (fromPath, toPath) => set(state => {
        const prefix = fromPath + '/'
        return {
          threads: state.threads.map(thread => ({
            ...thread,
            filePath: thread.filePath === fromPath
              ? toPath
              : thread.filePath.startsWith(prefix)
                ? toPath + thread.filePath.slice(fromPath.length)
                : thread.filePath,
          })),
        }
      }),

      removeThread: (id) => set(state => {
        const threads = state.threads.filter(thread => thread.id !== id)
        return {
          threads,
          activeThreadId: state.activeThreadId === id ? (threads[0]?.id ?? null) : state.activeThreadId,
        }
      }),

      clearThreads: () => set({ threads: [], activeThreadId: null }),

      updateLatestAssistantStatus: (threadId, status) => set(state => ({
        threads: updateThread(state.threads, threadId, thread => ({
          ...thread,
          updatedAt: Date.now(),
          messages: thread.messages.map((message, index, messages) => {
            const latestAssistant = messages.findLastIndex(item => item.role === 'assistant')
            return index === latestAssistant && message.status === 'done'
              ? { ...message, content: message.content.replace(/Document changes (?:ready for review|accepted by editor|reverted by editor)\.?$/, status) }
              : message
          }),
        })),
      })),

      beginExchange: (userText, filePath = '', vaultPath = '') => {
        const prompt = userText.trim()
        if (!prompt) return null

        const state = get()
        const existing = filePath
          ? state.threads.find(thread => thread.filePath === filePath && (thread.vaultPath ?? '') === vaultPath)
          : state.threads.find(thread => thread.id === state.activeThreadId && (thread.vaultPath ?? '') === vaultPath)
        const now = Date.now()
        const target: AiThread = existing ?? {
          id: uuid(),
          title: titleFromPrompt(prompt),
          filePath,
          vaultPath,
          createdAt: now,
          updatedAt: now,
          messages: [],
        }
        const assistantId = uuid()
        const baseThreads = existing ? state.threads : [target, ...state.threads]

        set({
          activeThreadId: target.id,
          threads: updateThread(baseThreads, target.id, thread => ({
            ...thread,
            title: thread.messages.length === 0 ? titleFromPrompt(prompt) : thread.title,
            filePath: filePath || thread.filePath,
            vaultPath: vaultPath || thread.vaultPath,
            updatedAt: now,
            messages: [
              ...thread.messages,
              { id: uuid(), role: 'user' as const, content: prompt, status: 'done' as const, createdAt: now },
              { id: assistantId, role: 'assistant' as const, content: '', status: 'streaming' as const, createdAt: now },
            ].slice(-MAX_MESSAGES_PER_THREAD),
          })).slice(0, MAX_THREADS),
        })

        return { threadId: target.id, assistantId }
      },

      setMessageContent: (threadId, messageId, content) => set(state => ({
        threads: updateThread(state.threads, threadId, thread => ({
          ...thread,
          updatedAt: Date.now(),
          messages: thread.messages.map(message => message.id === messageId ? { ...message, content } : message),
        })),
      })),

      finishMessage: (threadId, messageId, status, content) => set(state => ({
        threads: updateThread(state.threads, threadId, thread => ({
          ...thread,
          updatedAt: Date.now(),
          messages: thread.messages.map(message => message.id === messageId
            ? { ...message, status, content: content ?? message.content }
            : message),
        })),
      })),
    }),
    {
      name: 'docubook:ai-threads',
      version: 2,
      migrate: (persisted: any) => ({
        ...persisted,
        // Older records had no vault identity and must not leak into a vault.
        threads: (persisted?.threads ?? []).map((thread: AiThread) => ({ ...thread, vaultPath: thread.vaultPath ?? '' })),
      }),
      partialize: state => ({ threads: state.threads, activeThreadId: state.activeThreadId }),
    },
  ),
)
