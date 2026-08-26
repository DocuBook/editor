const ONBOARDING_KEY = 'docubook-onboarding-done'

export function isOnboardingDone(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === 'true'
}

export function markOnboardingDone(): void {
  localStorage.setItem(ONBOARDING_KEY, 'true')
}
