import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

/** Root error boundary — a render crash shows a recovery screen instead of a
 *  blank window (REL-6). Reload restarts the app; nothing is lost (tabs are
 *  flushed to disk before unmounts, and the store persists to localStorage). */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[error-boundary]', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex flex-col items-center justify-center gap-3 bg-[var(--bg-primary)] text-[var(--text-primary)]">
          <div className="text-base font-semibold">Something went wrong</div>
          <div className="text-xs text-[var(--text-muted)] max-w-sm text-center">
            The app hit an unexpected error. Your files are safe — reload to continue.
          </div>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            className="px-4 py-2 rounded-md bg-[var(--bg-hover)] text-sm cursor-pointer border-none hover:bg-[var(--bg-tertiary)]"
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
