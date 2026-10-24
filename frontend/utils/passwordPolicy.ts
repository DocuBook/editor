/** Password policy shared by the setup wizard's live checklist and submit
 *  validation. Kept pure so the rules are unit-testable without rendering. */

export interface PasswordRule {
  id: 'case' | 'length' | 'number-special'
  /** User-facing text shown in the multi-line checklist. */
  label: string
  /** Error text used by submit validation when this rule is unmet. */
  message: string
  test: (password: string) => boolean
}

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: 'case',
    label: 'A mix of upper and lower case letters',
    message: 'Password must include both upper and lower case letters',
    test: pw => /[a-z]/.test(pw) && /[A-Z]/.test(pw),
  },
  {
    id: 'length',
    label: 'Minimum 8 characters',
    message: 'Password must be at least 8 characters',
    test: pw => pw.length >= 8,
  },
  {
    id: 'number-special',
    label: 'A combination of numbers and special characters',
    message: 'Password must include numbers and special characters',
    test: pw => /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw),
  },
]

export interface PasswordRuleResult extends PasswordRule {
  met: boolean
}

/** Evaluates every rule against `password` — drives the realtime checklist. */
export function evaluatePassword(password: string): PasswordRuleResult[] {
  return PASSWORD_RULES.map(rule => ({ ...rule, met: rule.test(password) }))
}

export function isPasswordValid(password: string): boolean {
  return PASSWORD_RULES.every(rule => rule.test(password))
}

/** First unmet rule as an error message, or null when the password passes. */
export function passwordError(password: string): string | null {
  return PASSWORD_RULES.find(rule => !rule.test(password))?.message ?? null
}
