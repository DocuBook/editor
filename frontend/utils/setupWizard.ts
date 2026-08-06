/** Pure setup-wizard logic — extracted from SetupWizard.tsx so the
 *  token-gate fix is unit-testable without rendering the component (node env,
 *  no jsdom). Behavior is identical to the inline code it replaces. */

export interface SetupInput {
  email: string
  password: string
  confirm: string
  token: string
  tokenRequired: boolean
}

/** Returns an error message, or null when the input is valid. Order matters:
 *  email → password length → confirm match → setup token (server-gated). */
export function validateSetupInput({ email, password, confirm, token, tokenRequired }: SetupInput): string | null {
  if (!email.includes('@')) return 'Enter a valid email'
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (password !== confirm) return 'Passwords do not match'
  if (tokenRequired && !token.trim()) return 'Setup token is required — check the server env (DB_SETUP_TOKEN)'
  return null
}

/** Invoke args for setup_admin — token included ONLY when the server requires
 *  it (wizard must not send an absent token, and must send it trimmed
 *  when required). */
export function buildSetupPayload(email: string, password: string, token: string, tokenRequired: boolean) {
  return { email, password, ...(tokenRequired ? { token: token.trim() } : {}) }
}
