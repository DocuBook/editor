import { describe, expect, it } from 'vitest'

import {
  addMcpServer,
  editMcpServer,
  parseTimeout,
  removeMcpServer,
  timeoutsValid,
  type McpServer,
} from '../../../frontend/utils/mcpSettings'

const servers: McpServer[] = [
  { name: 'docs', url: 'https://mcp.example.com/docs', timeoutSeconds: 10, hasToken: true },
  { name: 'ops', url: 'https://mcp.example.com/ops', timeoutSeconds: null, hasToken: false },
]

describe('parseTimeout', () => {
  it('treats a blank field as the server default', () => {
    expect(parseTimeout('')).toBeNull()
    expect(parseTimeout('   ')).toBeNull()
    expect(parseTimeout(' 15 ')).toBe(15)
  })
})

describe('timeoutsValid', () => {
  it('accepts absent overrides and whole numbers in range', () => {
    expect(timeoutsValid(servers, 120)).toBe(true)
    expect(timeoutsValid([{ timeoutSeconds: 1 }, { timeoutSeconds: 120 }], 120)).toBe(true)
  })

  it('rejects fractions, zero, and values above the cap', () => {
    expect(timeoutsValid([{ timeoutSeconds: 1.5 }], 120)).toBe(false)
    expect(timeoutsValid([{ timeoutSeconds: 0 }], 120)).toBe(false)
    expect(timeoutsValid([{ timeoutSeconds: 121 }], 120)).toBe(false)
  })
})

describe('addMcpServer', () => {
  it('appends a normalized server', () => {
    const next = addMcpServer(servers, { name: 'wiki', url: 'https://mcp.example.com/wiki', timeoutSeconds: ' 30 ', token: 'secret' })

    expect(next).toHaveLength(3)
    expect(next[2]).toMatchObject({ name: 'wiki', timeoutSeconds: 30, token: 'secret' })
  })

  it('maps an empty timeout to null', () => {
    expect(addMcpServer(servers, { name: 'x', url: 'https://x', timeoutSeconds: '', token: '' })[2].timeoutSeconds).toBeNull()
  })
})

describe('editMcpServer', () => {
  /** The token is the risky part: an edit that only changes the URL must not
   *  wipe a stored credential. */
  it('keeps the stored token when the field is left blank', () => {
    const next = editMcpServer(servers, 'docs', { url: 'https://new.example.com', timeoutSeconds: '', token: '', removeToken: false })

    expect(next[0]).toMatchObject({ url: 'https://new.example.com', timeoutSeconds: null, hasToken: true })
    expect(next[0].token).toBeUndefined()
    expect(next[0].removeToken).toBeUndefined()
  })

  it('replaces the token when a new one is typed', () => {
    const next = editMcpServer(servers, 'docs', { url: servers[0].url, timeoutSeconds: '10', token: 'new-token', removeToken: false })

    expect(next[0].token).toBe('new-token')
    expect(next[0].removeToken).toBeUndefined()
  })

  it('clears the token when removal is requested, even with text in the field', () => {
    const next = editMcpServer(servers, 'docs', { url: servers[0].url, timeoutSeconds: '10', token: 'ignored', removeToken: true })

    expect(next[0]).toMatchObject({ token: '', removeToken: true })
  })

  it('leaves other servers untouched', () => {
    const next = editMcpServer(servers, 'docs', { url: 'https://new.example.com', timeoutSeconds: '', token: '', removeToken: false })

    expect(next[1]).toBe(servers[1])
  })
})

describe('removeMcpServer', () => {
  it('drops exactly the named server', () => {
    expect(removeMcpServer(servers, 'docs')).toEqual([servers[1]])
  })
})
