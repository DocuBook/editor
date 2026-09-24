import { describe, it, expect } from 'vitest'
import { uuid } from '../../../frontend/utils/uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  it('returns a valid v4 UUID', () => {
    expect(uuid()).toMatch(UUID_RE)
  })
  it('is unique across calls', () => {
    const a = new Set(Array.from({ length: 1000 }, () => uuid()))
    expect(a.size).toBe(1000)
  })
})
