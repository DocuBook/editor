/** Pure setup-wizard logic — extracted from SetupWizard.tsx so the
 *  token-gate fix is unit-testable without rendering the component (node env,
 *  no jsdom). Behavior is identical to the inline code it replaces. */

import { passwordError } from './passwordPolicy'

export interface SetupInput {
  email: string
  password: string
  confirm: string
  token: string
  tokenRequired: boolean
}

/** Returns an error message, or null when the input is valid. Order matters:
 *  email → password policy → confirm match → setup token (server-gated). */
export function validateSetupInput({ email, password, confirm, token, tokenRequired }: SetupInput): string | null {
  if (!email.includes('@')) return 'Enter a valid email'
  const pwErr = passwordError(password)
  if (pwErr) return pwErr
  if (password !== confirm) return 'Passwords do not match'
  if (tokenRequired && !token.trim()) return 'Setup token is required — see the hint under the field'
  return null
}

/** Where the server's setup token came from (`setup_status.setupTokenSource`). */
export type SetupTokenSource = 'env' | 'log' | null

export interface SetupTokenHint {
  title: string
  body: string
  /** Command the operator can copy to read the token, when there is one. */
  code?: string
}

/** Callout under the token field: where the operator finds the token.
 *  `env` → the operator set DB_SETUP_TOKEN; `log` → a one-time token was printed at boot. */
export function setupTokenHint(source: SetupTokenSource): SetupTokenHint | null {
  if (source === 'env') {
    return { title: 'Set by DB_SETUP_TOKEN', body: 'Enter the same value the server was started with.' }
  }
  if (source === 'log') {
    return {
      title: 'One-time token from the server log',
      body: 'Printed at first boot. Running locally, check the terminal. In Docker, run:',
      code: 'docker logs <container> | grep "one-time setup token"',
    }
  }
  return null
}

/** Invoke args for setup_admin — token included ONLY when the server requires
 *  it (wizard must not send an absent token, and must send it trimmed
 *  when required). */
export function buildSetupPayload(email: string, password: string, token: string, tokenRequired: boolean) {
  return { email, password, ...(tokenRequired ? { token: token.trim() } : {}) }
}
