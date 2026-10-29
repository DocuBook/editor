import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../frontend/lib/ipc', () => ({ isMacTauri: false }))

import { isApplePlatform, modifierClickLabel } from '../../../frontend/utils/modifierKey'

const stubNavigator = (value: object) => vi.stubGlobal('navigator', value)

describe('modifierClickLabel', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it.each([
    ['macOS via userAgentData', { userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }, 'Cmd+Click'],
    ['macOS via navigator.platform', { platform: 'MacIntel' }, 'Cmd+Click'],
    ['iPadOS', { platform: 'iPad' }, 'Cmd+Click'],
    ['Windows', { userAgentData: { platform: 'Windows' }, platform: 'Win32' }, 'Ctrl+Click'],
    ['Linux', { platform: 'Linux x86_64' }, 'Ctrl+Click'],
    ['no platform information', {}, 'Ctrl+Click'],
  ])('%s', (_name, navigatorValue, label) => {
    stubNavigator(navigatorValue)
    expect(modifierClickLabel()).toBe(label)
    expect(isApplePlatform()).toBe(label === 'Cmd+Click')
  })

  it('prefers userAgentData over the deprecated navigator.platform', () => {
    stubNavigator({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })
    expect(modifierClickLabel()).toBe('Ctrl+Click')
  })
})
