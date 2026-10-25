import { describe, expect, it } from 'vitest'
import { canAccessContainerChain, type AccessibleContainer } from './authorization.js'

function container(overrides: Partial<AccessibleContainer> = {}): AccessibleContainer {
  return { visibility: 'public', archivedAt: null, grants: [], ...overrides }
}

describe('container access chain', () => {
  it('allows admins to bypass grants for active containers', () => {
    expect(canAccessContainerChain('admin', 'alice', [
      container({ visibility: 'private', grants: [{ userId: 'bob', mode: 'deny' }] }),
    ])).toBe(true)
  })

  it('requires explicit allow for every private ancestor', () => {
    expect(canAccessContainerChain('member', 'bob', [
      container(),
      container({ visibility: 'private', grants: [{ userId: 'bob', mode: 'allow' }] }),
    ])).toBe(true)
    expect(canAccessContainerChain('member', 'carol', [
      container(),
      container({ visibility: 'private' }),
    ])).toBe(false)
  })

  it('lets an explicit deny at an ancestor hide the entire descendant chain', () => {
    expect(canAccessContainerChain('member', 'carol', [
      container({ grants: [{ userId: 'carol', mode: 'deny' }] }),
      container({ grants: [{ userId: 'carol', mode: 'allow' }] }),
    ])).toBe(false)
  })

  it('hides descendants when any ancestor is archived, including for administrators', () => {
    expect(canAccessContainerChain('member', 'bob', [
      container({ archivedAt: new Date('2026-01-01T00:00:00.000Z') }),
      container(),
    ])).toBe(false)
    expect(canAccessContainerChain('admin', 'alice', [container({ archivedAt: new Date() })])).toBe(false)
  })
})
