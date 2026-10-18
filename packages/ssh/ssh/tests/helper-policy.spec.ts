/** Policy resolution uses provider-owned remote coordinates, including on a different host OS. */

import { describe, expect, it, vi } from 'vitest'
import { FsTargetKey, FsVersion, type FileSystem } from '@deepseek-ai/dsh-fs'
import { resolveHelperPolicy } from '../src/helper.ts'

function remoteFilesystem() {
  const aliases = new Map([
    ['/remote/primary', '/volume/project'], ['/remote/primary-alias', '/volume/project'],
    ['/remote/extra', '/volume/library'], ['/remote/extra-alias', '/volume/library'],
  ])
  const types = new Map<string, 'directory' | 'file'>([
    ['/volume/project', 'directory'], ['/volume/library', 'directory'], ['/remote/file', 'file'],
  ])
  const fs = {
    resolve: vi.fn<FileSystem['resolve']>(async (path, opts) => {
      opts?.signal?.throwIfAborted()
      const canonical = aliases.get(path) ?? path
      return { targetKey: FsTargetKey(canonical), displayPath: canonical }
    }),
    processPath: vi.fn<FileSystem['processPath']>(target => target.displayPath),
    stat: vi.fn<FileSystem['stat']>(async (target, signal) => {
      signal?.throwIfAborted()
      const type = types.get(target.displayPath)
      return type === undefined ? undefined : { type, version: FsVersion('remote-version') }
    }),
  }
  return fs
}

describe('SSH helper policy resolution', () => {
  it.each(['read-only', 'workspace-write', 'danger-full-access'])('resolves and deduplicates every remote root under %s', async (mode) => {
    const fs = remoteFilesystem()
    const signal = new AbortController().signal
    const result = await resolveHelperPolicy(fs, {
      mode, workspaceRoot: '/remote/primary', sessionId: 'remote-session',
      additionalWorkspaceRoots: ['/remote/extra-alias', '/remote/extra', '/remote/primary-alias'],
    }, signal)
    expect(result).toEqual({
      mode, workspaceRoot: '/volume/project', sessionId: 'remote-session', additionalWorkspaceRoots: ['/volume/library'],
    })
    expect(fs.resolve.mock.calls.map(([path]) => path)).toEqual([
      '/remote/primary', '/remote/extra-alias', '/remote/extra', '/remote/primary-alias',
    ])
    for (const [, opts] of fs.resolve.mock.calls) expect(opts).toEqual({ signal })
    for (const [, observedSignal] of fs.stat.mock.calls) expect(observedSignal).toBe(signal)
  })

  it('preserves primary-only policy fields and canonicalization without adding an extra-root list', async () => {
    const fs = remoteFilesystem()
    expect(await resolveHelperPolicy(fs, {
      mode: 'workspace-write', workspaceRoot: '/remote/primary',
    }, new AbortController().signal)).toEqual({ mode: 'workspace-write', workspaceRoot: '/volume/project' })
    expect(fs.stat).not.toHaveBeenCalled()
  })

  it('preserves deployment grants without resolving aliases while canonicalizing workspace folders', async () => {
    const fs = remoteFilesystem()
    const deployment = ['/remote/extra-alias', '/remote/extra']
    expect(await resolveHelperPolicy(fs, {
      mode: 'workspace-write', workspaceRoot: '/remote/primary',
      additionalWorkspaceRoots: ['/remote/extra-alias'], additionalWritableRoots: deployment,
    }, new AbortController().signal)).toEqual({
      mode: 'workspace-write', workspaceRoot: '/volume/project',
      additionalWorkspaceRoots: ['/volume/library'], additionalWritableRoots: deployment,
    })
    expect(fs.resolve.mock.calls.map(([path]) => path)).toEqual(['/remote/primary', '/remote/extra-alias'])
  })

  it('keeps an explicit empty extra-root list and validates its primary directory', async () => {
    const fs = remoteFilesystem()
    expect(await resolveHelperPolicy(fs, {
      mode: 'workspace-write', workspaceRoot: '/remote/primary', additionalWorkspaceRoots: [],
    }, new AbortController().signal)).toEqual({ mode: 'workspace-write', workspaceRoot: '/volume/project', additionalWorkspaceRoots: [] })
    expect(fs.stat).toHaveBeenCalledOnce()
  })

  it.each([
    { root: '/remote/missing', code: 'FS_NOT_FOUND' }, { root: '/remote/file', code: 'FS_NOT_DIRECTORY' },
  ])('rejects extra root $root rather than returning a partial policy', async ({ root, code }) => {
    const fs = remoteFilesystem()
    await expect(resolveHelperPolicy(fs, {
      mode: 'workspace-write', workspaceRoot: '/remote/primary', additionalWorkspaceRoots: ['/remote/extra', root],
    }, new AbortController().signal)).rejects.toMatchObject({ code })
  })

  it('rejects a missing primary when extras are supplied', async () => {
    await expect(resolveHelperPolicy(remoteFilesystem(), {
      mode: 'read-only', workspaceRoot: '/remote/missing', additionalWorkspaceRoots: ['/remote/extra'],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('rejects a client-platform path before calling the remote filesystem', async () => {
    const fs = remoteFilesystem()
    await expect(resolveHelperPolicy(fs, {
      mode: 'workspace-write', workspaceRoot: '/remote/primary', additionalWorkspaceRoots: ['C:\\host-workspace'],
    }, new AbortController().signal)).rejects.toThrow()
    expect(fs.resolve).not.toHaveBeenCalled()
  })

  it('propagates filesystem cancellation without resolving more roots', async () => {
    const fs = remoteFilesystem()
    const reason = new Error('remote request cancelled')
    await expect(resolveHelperPolicy(fs, {
      mode: 'workspace-write', workspaceRoot: '/remote/primary', additionalWorkspaceRoots: ['/remote/extra'],
    }, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(fs.resolve).toHaveBeenCalledOnce()
    expect(fs.stat).not.toHaveBeenCalled()
  })
})
