type LogLevel = 'info' | 'warn' | 'error'
type LogMeta = Record<string, unknown>

const MAX_STRING = 300
const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|content|document|payload|request|session|token|secret/i
const SECRET_VALUE = /(bearer\s+|api[-_]?key\s*[:=]|session\s*[:=]|token\s*[:=])\S+/gi
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|private|opt|etc|Volumes)\/)[^\s"']+/g

function cleanString(value: string): string {
  const sanitized = value.replace(SECRET_VALUE, '$1[redacted]').replace(ABSOLUTE_PATH, '[path]')
  return sanitized.length > MAX_STRING ? `${sanitized.slice(0, MAX_STRING)}…` : sanitized
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') return cleanString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (value instanceof Error) return { name: cleanString(value.name), message: cleanString(value.message) }
  if (Array.isArray(value)) return value.slice(0, 10).map(item => sanitize(item, '', depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)]))
  }
  return cleanString(String(value))
}

function write(level: LogLevel, event: string, meta?: LogMeta): void {
  const method = level === 'info' ? 'info' : level
  console[method](`[frontend] ${cleanString(event)}`, meta ? sanitize(meta) : undefined)
}

/** Console-only diagnostics. Never persists or transmits telemetry. */
export const logger = {
  info: (event: string, meta?: LogMeta) => write('info', event, meta),
  warn: (event: string, meta?: LogMeta) => write('warn', event, meta),
  error: (event: string, meta?: LogMeta) => write('error', event, meta),
}

export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', event => logger.error('window_error', { error: event.error ?? event.message }))
  window.addEventListener('unhandledrejection', event => logger.error('unhandled_rejection', { error: event.reason }))
}
