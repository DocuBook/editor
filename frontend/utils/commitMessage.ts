/**
 * Auto-generated commit messages for the Commit action.
 *
 * The message is summarised by the configured AI from changed-file and diff
 * statistics. The result uses the app's `Auto commit : subject` format. When
 * AI is unavailable, a deterministic fallback is used.
 */
import { invoke, listen } from '../lib/ipc'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { getAiConfig } from './aiConfig'

export interface CommitFile {
  /** Porcelain index/worktree letter (`A`, `M`, `D`, `R`, `U`). */
  status: string
  path: string
}

const SUBJECT_MAX = 100

/** Hard cap on the AI round-trip; past it the fallback message is used so a
 *  stalled provider never blocks Commit. */
const AI_MESSAGE_TIMEOUT_MS = 20_000

const COMMIT_SYSTEM_PROMPT = [
  'You summarise a git diff for a commit message.',
  'Reply with ONLY the requested text — no code fences, quotes, or explanation.',
  'The first line MUST be `Auto commit : ` followed by a concise summary of the largest or most meaningful diff.',
  'The subject must be at most 100 characters including the prefix, specific, and plain language; do not use conventional commit types or scopes.',
  'Return only one subject line; do not add a body, file list, or explanation.',
  'Prefer the largest diff/stat impact when choosing the subject.',
].join(' ')

/** Porcelain `XY path` lines → commit files. Staged entries (index !== '.')
 *  win; when nothing is staged the worktree changes are used instead. */
export function parseCommitFiles(status: string): CommitFile[] {
  const lines = status.trim() ? status.split('\n').filter(line => line.trim().length > 3) : []
  const parsed = lines.map(line => ({
    index: line[0],
    worktree: line[1],
    path: line.substring(3).trim(),
  }))
  const staged = parsed.filter(line => line.index !== '.' && line.index !== '?' && line.index !== ' ')
  const selected = staged.length > 0 ? staged : parsed
  return selected.map(line => ({
    status: line.index === '?' ? 'A' : line.index !== '.' && line.index !== ' ' ? line.index : line.worktree,
    path: line.path,
  }))
}

/** Deterministic fallback matching the same simple format as the AI output. */
export function fallbackCommitMessage(files: CommitFile[], fallbackName?: string): string {
  const target = files.length === 1 ? basename(files[0].path) : files.length > 1 ? `${files.length} files` : fallbackName?.trim() || 'vault'
  return sanitizeCommitMessage(`Auto commit : update ${target}`)
}

/** Normalise model output: force the requested prefix and clamp to one subject line. */
export function sanitizeCommitMessage(raw: string): string {
  const lines = raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\p{Cc}]/gu, ' ').trim())
  const subjectIndex = lines.findIndex(Boolean)
  if (subjectIndex === -1) return ''
  const rawSubject = lines[subjectIndex].replace(/^[-*]\s+/, '').replace(/^Auto commit\s*:\s*/i, '').trim()
  const subject = clamp(`Auto commit : ${rawSubject}`, SUBJECT_MAX)
  return subject
}

/** Ask the configured model to summarise the changed files. Throws when AI is
 *  unconfigured or the stream fails — callers fall back to the deterministic
 *  message. Tokens arrive on the shared `ai:token` event, so a concurrent AI
 *  panel stream would interleave; commit generation is short and user-initiated. */
export async function generateCommitMessage(files: CommitFile[], diffSummary = ''): Promise<string> {
  const { provider, model, baseUrl } = await getAiConfig()
  if (!provider || !model || !baseUrl) throw new Error('AI is not configured')
  if (provider !== CUSTOM_PROVIDER_ID && !useAiSettings.getState().savedProviders.includes(provider)) {
    throw new Error('AI is not configured')
  }
  const tokens: string[] = []
  const unlisten = await listen<string>('ai:token', event => { tokens.push(String(event.payload)) })
  try {
    await invoke('ask_ai', {
      messages: JSON.stringify([
        { role: 'system', content: COMMIT_SYSTEM_PROMPT },
        { role: 'user', content: `Changed files:\n${files.map(file => `- ${file.status} ${file.path}`).join('\n') || '- (none)'}\n\nDiff statistics (prioritise the largest changes):\n${diffSummary || '- unavailable'}` },
      ]),
      provider,
      model,
      baseUrl,
    })
  } finally {
    unlisten()
  }
  return sanitizeCommitMessage(tokens.join(''))
}

/** Commit message for a porcelain status: AI summary when available, else the
 *  deterministic file-list fallback. Never rejects. */
export async function autoCommitMessage(status: string, fallbackName?: string, diffSummary = ''): Promise<string> {
  const files = parseCommitFiles(status)
  try {
    const message = await withTimeout(generateCommitMessage(files, diffSummary), AI_MESSAGE_TIMEOUT_MS)
    if (message) return message
  } catch { /* unconfigured, failed, or timed out — fall back below */ }
  return fallbackCommitMessage(files, fallbackName)
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trimEnd() : value
}

function basename(path: string): string {
  return path.split('/').pop() || path
}


function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI commit message timed out')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}
