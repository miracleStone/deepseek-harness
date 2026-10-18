/**
 * workspaceWriteSid tests: the per-workspace write identity is deterministic
 * (the same canonical path always derives the same SID — the property the
 * cross-session grant reuse rests on), capability-shaped, distinct across
 * workspaces, and byte-sensitive (the canonical path is the caller's
 * contract; an alias spelling derives a second identity, self-healing at
 * the cost of one extra tree propagation).
 */

import { describe, expect, it } from 'vitest'

import { tempWriteSid, workspaceWriteSid } from '../src/index.ts'

describe('workspaceWriteSid', () => {
  it('derives a stable capability-shaped SID per workspace path', () => {
    const first = workspaceWriteSid('C:\\Users\\agent\\repo')
    const second = workspaceWriteSid('C:\\Users\\agent\\repo')
    expect(first).toBe(second)
    expect(first).toBe('S-1-4-907248133-152761708')
    expect(first).toMatch(/^S-1-4-\d+-\d+$/u)
  })

  it('keeps the single-root identity when an array contains only that canonical root', () => {
    const root = 'C:\\Users\\agent\\repo'
    expect(workspaceWriteSid([root])).toBe(workspaceWriteSid(root))
    expect(workspaceWriteSid([root, root])).toBe(workspaceWriteSid(root))
  })

  it('derives a stable identity for the sorted deduplicated root set, not its primary root', () => {
    const first = 'C:\\work-a'
    const second = 'D:\\work-b'
    const sid = workspaceWriteSid([first, second])
    expect(sid).toMatch(/^S-1-4-\d+-\d+$/u)
    expect(sid).toBe(workspaceWriteSid([second, first, second]))
    expect(sid).not.toBe(workspaceWriteSid(first))
    expect(sid).not.toBe(workspaceWriteSid(second))
    expect(sid).not.toBe(workspaceWriteSid([first, 'D:\\work-c']))
  })

  it('rejects an empty workspace set', () => {
    expect(() => workspaceWriteSid([])).toThrow('requires at least one workspace root')
  })

  it('derives distinct identities for distinct workspaces', () => {
    expect(workspaceWriteSid('C:\\Users\\agent\\repo-a')).not.toBe(workspaceWriteSid('C:\\Users\\agent\\repo-b'))
  })

  it('is byte-sensitive: the canonical path is the caller\'s contract (an alias spelling derives a second identity)', () => {
    expect(workspaceWriteSid('C:\\Repo')).not.toBe(workspaceWriteSid('c:\\repo'))
    expect(workspaceWriteSid('C:\\Repo\\')).not.toBe(workspaceWriteSid('C:\\Repo'))
  })
})

describe('tempWriteSid', () => {
  it('derives a stable domain-separated SID per private temp path', () => {
    const temp = tempWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123')
    expect(temp).toBe(tempWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123'))
    expect(temp).toMatch(/^S-1-4-\d+-\d+-1$/u)
    expect(temp).not.toBe(workspaceWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123'))
  })

  it('derives distinct capabilities for distinct private temp paths', () => {
    expect(tempWriteSid('C:\\Temp\\dsh-a')).not.toBe(tempWriteSid('C:\\Temp\\dsh-b'))
  })
})
