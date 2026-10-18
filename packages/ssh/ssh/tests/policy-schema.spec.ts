/** SSH policy paths remain remote POSIX coordinates until the helper resolves them. */

import { describe, expect, it } from 'vitest'
import { policySchema } from '../src/schemas.ts'

describe('SSH sandbox policy JSON', () => {
  it.each(['read-only', 'workspace-write', 'danger-full-access'])('preserves optional remote roots under %s', (mode) => {
    const primary = { mode, workspaceRoot: '/remote/primary' }
    expect(policySchema.parse(primary)).toEqual(primary)
    expect(policySchema.parse({ ...primary, additionalWorkspaceRoots: [] })).toEqual({ ...primary, additionalWorkspaceRoots: [] })
    const roots = ['/remote/extra', '/remote/alias/../extra', '/remote/extra']
    expect(policySchema.parse({ ...primary, additionalWorkspaceRoots: roots })).toEqual({ ...primary, additionalWorkspaceRoots: roots })
    const combined = { ...primary, additionalWorkspaceRoots: roots, additionalWritableRoots: ['/remote/deployed'] }
    expect(policySchema.parse(combined)).toEqual(combined)
  })

  it.each([
    { roots: ['relative'] }, { roots: [''] }, { roots: ['C:\\workspace'] }, { roots: ['/remote/invalid\0root'] },
    { roots: [42] }, { roots: null }, { roots: '/remote/extra' },
  ])('rejects invalid additional root input $roots', ({ roots }) => {
    expect(policySchema.safeParse({
      mode: 'workspace-write', workspaceRoot: '/remote/primary', additionalWorkspaceRoots: roots,
    }).success).toBe(false)
  })

  it('keeps unrelated unknown policy fields invalid', () => {
    expect(policySchema.safeParse({
      mode: 'workspace-write', workspaceRoot: '/remote/primary', additionalWorkspaceRoots: ['/remote/extra'], unconfined: true,
    }).success).toBe(false)
  })
})
