/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift, and so the workspace-plus-
 * additional set stays one shared derivation across backend dialects.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('workspaceWritableRoots', () => {
  it('workspace-write grants only the workspace when no extra root is configured', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws })).toEqual([realpathSync.native(ws)])
  })

  it('workspace-write deduplicates physical extra directories and rejects symlink aliases', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    const alias = join(ws, 'alias')
    symlinkSync(extra, alias, process.platform === 'win32' ? 'junction' : 'dir')
    roots.push(ws, extra)
    try {
      const grants = workspaceWritableRoots({
        mode: 'workspace-write',
        workspaceRoot: ws,
        additionalWritableRoots: [extra, extra],
      })
      expect(grants).toEqual([realpathSync.native(ws), realpathSync.native(extra)])
      expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [alias] }))
        .toThrow('use the physical directory path')
    } finally {
      unlinkSync(alias)
    }
  })

  it('combines both grant sources without bypassing physical-directory validation', () => {
    const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-ws-')))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    const deployed = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-deployed-')))
    roots.push(ws, extra, deployed)
    const alias = join(ws, 'alias')
    symlinkSync(extra, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const policy = {
        mode: 'workspace-write' as const, workspaceRoot: ws,
        additionalWorkspaceRoots: [alias, extra], additionalWritableRoots: [extra, deployed],
      }
      expect(workspaceWritableRoots(policy)).toEqual([ws, extra, deployed])
      expect(() => workspaceWritableRoots({ ...policy, additionalWritableRoots: [alias] }))
        .toThrow('use the physical directory path')
      expect(workspaceWritableRoots({ ...policy, mode: 'read-only' })).toEqual([])
    } finally {
      unlinkSync(alias)
    }
  })

  it('rejects missing and non-directory extra roots before granting access', () => {
    const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-roots-')))
    roots.push(ws)
    const file = join(ws, 'file.txt')
    writeFileSync(file, 'file')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [file] }))
      .toThrow('expected an existing directory')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [join(ws, 'missing')] }))
      .toThrow('cannot read the directory')
  })

  it('read-only grants nothing even when extra roots are carried on the policy', () => {
    expect(workspaceWritableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
    expect(writableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
  })
})

describe('writableRoots', () => {
  it.each(['read-only', 'danger-full-access'] as const)('%s grants no writable roots, including extras', (mode) => {
    expect(writableRoots({ mode, workspaceRoot: process.cwd(), additionalWorkspaceRoots: [tmpdir()] })).toEqual([])
  })

  it('grants additional workspace roots once after canonicalizing aliases', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = mkdtempSync(join(tmpdir(), 'dsh-extra-ws-'))
    roots.push(ws, extra)
    const alias = join(ws, 'alias')
    symlinkSync(extra, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const writable = writableRoots({
        mode: 'workspace-write', workspaceRoot: ws, additionalWorkspaceRoots: [extra, alias, ws, extra],
      })
      expect(writable).toEqual([...new Set([ws, extra, '/tmp', tmpdir()].map(canonicalPath))])
    } finally {
      unlinkSync(alias)
    }
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('workspace-write includes an explicit extra directory beside the temp areas', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    roots.push(ws, extra)
    expect(writableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra],
    })).toContain(realpathSync.native(extra))
  })
})
