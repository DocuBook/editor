import { Check, X } from 'lucide-react'
import { evaluatePassword } from '../utils/passwordPolicy'

/** Live, multi-line password requirement checklist. Rendered under the
 *  password field once the user starts typing; `aria-live` announces each
 *  rule as it flips to met. */
export default function PasswordRequirements({ password }: { password: string }) {
  if (!password) return null
  return (
    <ul className="flex flex-col gap-1 mt-1" aria-live="polite">
      {evaluatePassword(password).map(({ id, label, met }) => (
        <li
          key={id}
          className={`flex items-start gap-1.5 text-[11px] leading-tight ${met ? 'text-success' : 'text-muted'}`}
        >
          {met ? <Check size={12} className="mt-0.5 shrink-0" /> : <X size={12} className="mt-0.5 shrink-0" />}
          <span>{label} <span className="sr-only">{met ? 'Met' : 'Not met'}</span></span>
        </li>
      ))}
    </ul>
  )
}
