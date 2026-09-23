/**
 * Auto-generated commit messages for the Commit action.
 *
 * A single-file change set is named deterministically — the fallback already
 * carries the file name, so an AI round-trip would only add latency. Larger
 * change sets are summarised by the configured AI from the changed files and a
 * bounded diff excerpt. The result uses the app's `Auto commit : subject`
 * format. When AI is unavailable, a deterministic fallback is used.
 */
import { invoke, listen } from '../lib/ipc'
import { useAiSettings, CUSTOM_PROVIDER_ID } from '../stores/aiSettings'
import { getAiConfig } from './aiConfig'
import { uuid } from './uuid'

export interface CommitFile {
  /** Porcelain index/worktree letter (`A`, `M`, `D`, `R`, `U`). */
  status: string
  path: string
}

const SUBJECT_MAX = 100

/** Hard cap on the AI round-trip; past it the fallback message is used so a
 *  stalled provider never blocks Commit. */
const AI_MESSAGE_TIMEOUT_MS = 20_000

/** Change sets smaller than this skip the AI: the deterministic message already
 *  names the single file involved, so a round-trip buys nothing. */
const AI_SUMMARY_MIN_FILES = 2

const COMMIT_SYSTEM_PROMPT = [
  'You write a git commit subject for a change set.',
  'The first line MUST be `Auto commit : ` followed by a concise summary of what the change set does as a whole.',
  'With several files, describe their shared intent instead of naming one file, and judge that intent from the diff rather than from the file names.',
  'The subject must be at most 100 characters including the prefix, specific, and plain language; do not use conventional commit types or scopes.',
  'Reply with ONLY the subject — no code fences, quotes, body, file list, or explanation.',
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

/** Ask the configured model to summarise the changed files and their diff.
 *  Throws when AI is unconfigured or the stream fails — callers fall back to the
 *  deterministic message. `loadDiff` is only called once the model is known to
 *  be configured, and a failing diff degrades the prompt instead of the result.
 *  `ai:token` is a shared event, so this request carries its own id and ignores
 *  any other stream's tokens (a concurrent AI panel turn included). */
export async function generateCommitMessage(files: CommitFile[], loadDiff?: () => Promise<string>): Promise<string> {
  const { provider, model, baseUrl } = await getAiConfig()
  if (!provider || !model || !baseUrl) throw new Error('AI is not configured')
  if (provider !== CUSTOM_PROVIDER_ID && !useAiSettings.getState().savedProviders.includes(provider)) {
    throw new Error('AI is not configured')
  }
  const diff = loadDiff ? await loadDiff().catch(() => '') : ''
  const tokens: string[] = []
  const requestId = uuid()
  const unlisten = await listen<{ requestId?: string; token?: string }>('ai:token', event => {
    if (event.payload?.requestId !== requestId) return
    tokens.push(String(event.payload.token ?? ''))
  })
  try {
    await invoke('ask_ai', {
      messages: JSON.stringify([
        { role: 'system', content: COMMIT_SYSTEM_PROMPT },
        { role: 'user', content: `Changed files:\n${files.map(file => `- ${file.status} ${file.path}`).join('\n') || '- (none)'}\n\nDiff excerpt (largest files first; judge intent from it):\n${diff || '- unavailable, infer the subject from the file names'}` },
      ]),
      provider,
      model,
      baseUrl,
      requestId,
    })
  } finally {
    unlisten()
  }
  return sanitizeCommitMessage(tokens.join(''))
}

/** Commit message for a porcelain status: the deterministic name for a single
 *  file, an AI summary of the diff for a larger change set, and the fallback
 *  whenever AI is unconfigured, fails, or times out. Never rejects. */
export async function autoCommitMessage(status: string, fallbackName?: string, loadDiff?: () => Promise<string>): Promise<string> {
  const files = parseCommitFiles(status)
  if (files.length < AI_SUMMARY_MIN_FILES) return fallbackCommitMessage(files, fallbackName)
  try {
    const message = await withTimeout(generateCommitMessage(files, loadDiff), AI_MESSAGE_TIMEOUT_MS)
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
