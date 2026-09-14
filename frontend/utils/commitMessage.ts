/**
 * Auto-generated commit messages for the Commit action.
 *
 * The message is summarised by the configured AI from the changed-file list
 * only (no diff scan): conventional `<type>(<scope>): <subject>` plus optional
 * body bullets. When AI is unconfigured or fails, a deterministic fallback
 * derived from the file list is used so Commit never blocks.
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
const BULLET_MAX = 100
const MAX_BULLETS = 5
/** Hard cap on the AI round-trip; past it the fallback message is used so a
 *  stalled provider never blocks Commit. */
const AI_MESSAGE_TIMEOUT_MS = 20_000

const COMMIT_SYSTEM_PROMPT = [
  'You write git commit messages from a list of changed files.',
  'Reply with ONLY the commit message — no code fences, no quotes, no explanation.',
  'First line: `<type>(<scope>): <subject>`.',
  'type is one of feat, fix, docs, chore, refactor, style, test, perf, build, ci.',
  'scope is a short lowercase area derived from the paths; omit it when unclear.',
  'subject is imperative, lowercase, no trailing period, at most 100 characters.',
  `Then optionally a blank line and up to ${MAX_BULLETS} body bullets, each starting with "- " and at most ${BULLET_MAX} characters, describing what changed.`,
  'Omit the body entirely for a trivial single change.',
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

/** Deterministic fallback when AI is unavailable: never collapses to a single
 *  generic word, always conventional `<type>(<scope>): <subject>`. */
export function fallbackCommitMessage(files: CommitFile[], fallbackName?: string): string {
  if (files.length === 0) {
    const name = fallbackName?.trim()
    return sanitizeCommitMessage(name ? `docs: update ${name}` : 'chore: update vault')
  }
  const scope = commonScope(files)
  const type = files.every(file => /\.(md|mdx)$/i.test(file.path)) ? 'docs' : 'chore'
  const action = files.every(file => file.status === 'A') ? 'add'
    : files.every(file => file.status === 'D') ? 'remove'
    : files.every(file => file.status === 'R') ? 'rename'
    : 'update'
  const target = files.length === 1 ? basename(files[0].path) : `${files.length} files`
  const header = `${type}${scope ? `(${scope})` : ''}: ${action} ${target}`
  const body = files.length > 1 ? files.slice(0, MAX_BULLETS).map(file => `- ${file.path}`) : []
  return sanitizeCommitMessage([header, ...(body.length > 0 ? ['', ...body] : [])].join('\n'))
}

/** Normalise model output: strip fences, force a single clamped subject line,
 *  keep only bullet body lines (each clamped), drop everything else. */
export function sanitizeCommitMessage(raw: string): string {
  const lines = raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\p{Cc}]/gu, ' ').trim())
  const subjectIndex = lines.findIndex(Boolean)
  if (subjectIndex === -1) return ''
  const subject = clamp(lines[subjectIndex].replace(/^[-*]\s+/, ''), SUBJECT_MAX)
  const body = lines.slice(subjectIndex + 1)
    .filter(line => line.startsWith('-'))
    .map(line => clamp(line.replace(/\s+/g, ' '), BULLET_MAX))
    .slice(0, MAX_BULLETS)
  return [subject, ...(body.length > 0 ? ['', ...body] : [])].join('\n')
}

/** Ask the configured model to summarise the changed files. Throws when AI is
 *  unconfigured or the stream fails — callers fall back to the deterministic
 *  message. Tokens arrive on the shared `ai:token` event, so a concurrent AI
 *  panel stream would interleave; commit generation is short and user-initiated. */
export async function generateCommitMessage(files: CommitFile[]): Promise<string> {
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
        { role: 'user', content: `Changed files:\n${files.map(file => `- ${file.status} ${file.path}`).join('\n') || '- (none)'}` },
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
export async function autoCommitMessage(status: string, fallbackName?: string): Promise<string> {
  const files = parseCommitFiles(status)
  try {
    const message = await withTimeout(generateCommitMessage(files), AI_MESSAGE_TIMEOUT_MS)
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

function commonScope(files: CommitFile[]): string {
  const dirs = new Set(files.map(file => (file.path.includes('/') ? file.path.split('/')[0] : '')))
  const [scope] = [...dirs]
  return dirs.size === 1 ? scope : ''
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
