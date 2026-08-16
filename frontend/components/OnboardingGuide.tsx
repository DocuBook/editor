import { FileText, Sparkles, GitBranch, Keyboard } from 'lucide-react'
import { isTauri } from '../lib/ipc'

const ONBOARDING_KEY = 'docubook-onboarding-done'

export function isOnboardingDone(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === 'true'
}

export function markOnboardingDone(): void {
  localStorage.setItem(ONBOARDING_KEY, 'true')
}

const steps = [
  {
    icon: FileText,
    title: 'Create your first note',
    body: `Click the + button in the sidebar or press ${isTauri ? '\u2318N' : '\u2318\u21E7F'} to create a new note. Name it anything — the .md extension is added automatically.`,
  },
  {
    icon: Keyboard,
    title: 'Switch modes',
    body: 'Toggle between Editor (WYSIWYG) and Markdown (source code) with ⌘⇧E or the button in the toolbar.',
  },
  {
    icon: Sparkles,
    title: 'Write with AI',
    body: 'In Editor mode, press ⌃⌥L or click ✨ to ask AI to write, improve, or summarize. Configure your API key in Settings (⌘,).',
  },
  {
    icon: GitBranch,
    title: 'Track changes with Git',
    body: 'Initialize a git repo from Settings (⌘, → Git tab) to version your vault. Stage, commit, and push — all inside the app.',
  },
]

export default function OnboardingGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-background p-8">
      <div className="max-w-lg w-full">
        <h2 className="text-lg font-semibold text-foreground mb-1">Welcome to DocuBook Editor</h2>
        <p className="text-sm text-zinc-500 mb-8">Your vault is ready. Here's how to get started.</p>

        <div className="space-y-5">
          {steps.map((s, i) => (
            <div key={i} className="flex gap-4">
              <div className="mt-0.5 shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                <s.icon size={16} />
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground-secondary">{s.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed mt-0.5">{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onDismiss}
          className="mt-8 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg cursor-pointer border-none transition-colors"
        >
          Got it — start writing
        </button>
        <p className="mt-2 text-xs text-zinc-600 leading-relaxed">
          This guide returns until your vault has a note — create one with the + button in the sidebar ({isTauri ? '⌘N' : '⌘⇧F'}).
        </p>
      </div>
    </div>
  )
}
