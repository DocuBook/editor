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
  beginExchange: (userText: string, filePath?: string) => { threadId: string; assistantId: string } | null
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

      beginExchange: (userText, filePath = '') => {
        const prompt = userText.trim()
        if (!prompt) return null

        const state = get()
        const existing = filePath
          ? state.threads.find(thread => thread.filePath === filePath)
          : state.threads.find(thread => thread.id === state.activeThreadId)
        const now = Date.now()
        const target: AiThread = existing ?? {
          id: uuid(),
          title: titleFromPrompt(prompt),
          filePath,
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
      version: 1,
      partialize: state => ({ threads: state.threads, activeThreadId: state.activeThreadId }),
    },
  ),
)
