/** Multi-root profiles and provider-owned Windows grants without native ACL mutations. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workspaceWriteSid } from '../src/workspace-sid.ts'

interface GrantRecord {
  writeSid: string
  added: Array<{ path: string; standing: boolean }>
  dispose: ReturnType<typeof vi.fn>
}

const state = vi.hoisted(() => ({
  grants: [] as GrantRecord[],
  failPath: undefined as string | undefined,
  failTemp: false,
}))

vi.mock('@deepseek-ai/dsh-sandbox-windows-acl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/index.ts')>()
  return {
    ...actual,
    AclWriteGrant: {
      create(writeSid: string) {
        const record: GrantRecord = { writeSid, added: [], dispose: vi.fn() }
        state.grants.push(record)
        return {
          add(path: string, standing = false) {
            record.added.push({ path, standing })
            if (path === state.failPath || (!standing && state.failTemp)) throw new Error('grant refused')
          },
          dispose: record.dispose,
        }
      },
    },
  }
})

const scratchDirs: string[] = []
const links: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const link of links.splice(0)) unlinkSync(link)
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  state.grants = []
  state.failPath = undefined
  state.failTemp = false
})

function scratch(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-multi-root-')))
  scratchDirs.push(dir)
  return dir
}

function rootsPolicy(): SandboxPolicy {
  const workspaceRoot = scratch()
  const extra = scratch()
  return { mode: 'workspace-write', workspaceRoot, additionalWorkspaceRoots: [extra], sessionId: SessionId('multi') }
}

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSandboxProvider, {})
  disposers.push(async () => { await fiber.dispose() })
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform: 'win32', windowsAclRunnerArgs: ['node', 'runner.js'] }
  return { sandbox, fiber }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

function workspaceFlags(argv: readonly string[]): string[] {
  return argv.flatMap((value, index) => value === '--workspace' ? [argv[index + 1]!] : [])
}

describe('additional workspace process roots', () => {
  it('adds canonical deduplicated mounts and grants without changing single-root arguments', () => {
    const policy = rootsPolicy()
    const extra = policy.additionalWorkspaceRoots![0]!
    const alias = join(policy.workspaceRoot, 'extra-alias')
    symlinkSync(extra, alias, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(alias)
    const multi = { ...policy, additionalWorkspaceRoots: [extra, alias, policy.workspaceRoot, extra] }
    const single = { mode: policy.mode, workspaceRoot: policy.workspaceRoot }
    expect(bwrapProfileArgs(multi)).toEqual([...bwrapProfileArgs(single), '--bind', extra, extra])
    expect(landlockProfileArgs(multi)).toEqual([...landlockProfileArgs(single), '--rw', extra])
    const profile = seatbeltProfileArgs(multi)[1]!
    expect(profile.split(`(subpath ${JSON.stringify(extra)})`)).toHaveLength(2)
    expect(profile.split(`(subpath ${JSON.stringify(policy.workspaceRoot)})`)).toHaveLength(2)
    for (const builder of [bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs]) {
      expect(builder({ ...multi, mode: 'read-only' })).toEqual(builder({ ...single, mode: 'read-only' }))
    }
  })

  it.each(['read-only', 'workspace-write'] as const)('rejects invalid extra roots before selecting or granting under %s', async (mode) => {
    const { sandbox } = await setup()
    const workspaceRoot = scratch()
    const file = join(workspaceRoot, 'file.txt')
    writeFileSync(file, 'not a directory')
    const invalid = ['relative-root', '', join(workspaceRoot, 'missing'), file]
    if (process.platform === 'win32') invalid.push('\\root-relative')
    for (const extra of invalid) {
      await expect(sandbox.confine(['true'], {
        mode, workspaceRoot, additionalWorkspaceRoots: [extra], sessionId: SessionId('invalid'),
      })).rejects.toThrow()
    }
    expect(state.grants).toEqual([])
    await expect(sandbox.confine(['true'], {
      mode, workspaceRoot: join(workspaceRoot, 'missing-primary'), additionalWorkspaceRoots: [workspaceRoot],
    })).rejects.toThrow()
  })

  it('keeps Windows deployment grants unsupported even when the same folder is a workspace root', async () => {
    const { sandbox } = await setup()
    const policy = rootsPolicy()
    const deployed = policy.additionalWorkspaceRoots![0]!
    await expect(sandbox.confine(['true'], { ...policy, additionalWritableRoots: [deployed] }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNSUPPORTED_POLICY' })
    expect(state.grants).toEqual([])
    const readOnly = await sandbox.confine(['true'], { ...policy, mode: 'read-only', additionalWritableRoots: [deployed] })
    expect(flag(readOnly.argv, '--write-sid')).toBeUndefined()
    expect(state.grants).toEqual([])
  })

  it('reuses one standing set capability and one private temp per session regardless of root order or aliases', async () => {
    const { sandbox, fiber } = await setup()
    const policy = rootsPolicy()
    const extra = policy.additionalWorkspaceRoots![0]!
    const alias = join(policy.workspaceRoot, 'extra-alias')
    symlinkSync(extra, alias, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(alias)
    const first = await sandbox.confine(['true'], policy)
    const reordered = await sandbox.confine(['true'], {
      ...policy, workspaceRoot: alias, additionalWorkspaceRoots: [policy.workspaceRoot, extra, alias],
    })
    expect(workspaceFlags(first.argv)).toEqual([policy.workspaceRoot, extra])
    expect(workspaceFlags(reordered.argv)).toEqual([extra, policy.workspaceRoot])
    const writeSid = workspaceWriteSid([policy.workspaceRoot, extra])
    expect(flag(first.argv, '--write-sid')).toBe(writeSid)
    expect(flag(reordered.argv, '--write-sid')).toBe(writeSid)
    expect(flag(reordered.argv, '--temp')).toBe(flag(first.argv, '--temp'))
    expect(state.grants).toHaveLength(2)
    expect(state.grants[0]!.added).toEqual([policy.workspaceRoot, extra].sort().map(path => ({ path, standing: true })))

    const sibling = await sandbox.confine(['true'], { ...policy, sessionId: SessionId('sibling') })
    expect(flag(sibling.argv, '--write-sid')).toBe(writeSid)
    expect(flag(sibling.argv, '--temp')).not.toBe(flag(first.argv, '--temp'))
    expect(flag(sibling.argv, '--temp-write-sid')).not.toBe(flag(first.argv, '--temp-write-sid'))
    const narrowed = await sandbox.confine(['true'], { ...policy, additionalWorkspaceRoots: [] })
    expect(flag(narrowed.argv, '--write-sid')).toBe(workspaceWriteSid(policy.workspaceRoot))
    expect(flag(narrowed.argv, '--temp')).not.toBe(flag(first.argv, '--temp'))
    expect(state.grants).toHaveLength(5)

    await fiber.dispose()
    for (const grant of state.grants) expect(grant.dispose).toHaveBeenCalledOnce()
    for (const result of [first, sibling, narrowed]) expect(existsSync(flag(result.argv, '--temp')!)).toBe(false)
  })

  it('read-only carries roots for validation but creates no grants or write capabilities', async () => {
    const { sandbox } = await setup()
    const policy = rootsPolicy()
    const result = await sandbox.confine(['true'], { ...policy, mode: 'read-only' })
    expect(workspaceFlags(result.argv)).toEqual([policy.workspaceRoot, ...policy.additionalWorkspaceRoots!])
    expect(flag(result.argv, '--write-sid')).toBeUndefined()
    expect(flag(result.argv, '--temp-write-sid')).toBeUndefined()
    expect(state.grants).toEqual([])
    await sandbox.confine(['true'], policy)
    await sandbox.confine(['true'], { ...policy, mode: 'read-only' })
    expect(state.grants).toHaveLength(2)
  })

  it('rejects an extra root containing the ambient temp root before any ACL mutation', async () => {
    const { sandbox } = await setup()
    await expect(sandbox.confine(['true'], {
      ...rootsPolicy(), additionalWorkspaceRoots: [tmpdir()],
    })).rejects.toThrow('temp root must be outside the workspace')
    expect(state.grants).toEqual([])
  })

  it('frees a partially materialized set grant and retries every root without caching a failed set', async () => {
    const { sandbox } = await setup()
    const policy = rootsPolicy()
    const roots = [policy.workspaceRoot, ...policy.additionalWorkspaceRoots!].sort()
    state.failPath = roots[1]
    await expect(sandbox.confine(['true'], policy)).rejects.toThrow('grant refused')
    expect(state.grants).toHaveLength(1)
    expect(state.grants[0]!.added).toEqual(roots.map(path => ({ path, standing: true })))
    expect(state.grants[0]!.dispose).toHaveBeenCalledOnce()
    state.failPath = undefined
    await sandbox.confine(['true'], policy)
    expect(state.grants).toHaveLength(3)
    expect(state.grants[1]!.added).toEqual(roots.map(path => ({ path, standing: true })))
  })

  it('revokes a failed temp grant and removes its private directory while retaining reusable standing roots', async () => {
    const { sandbox } = await setup()
    const policy = rootsPolicy()
    state.failTemp = true
    await expect(sandbox.confine(['true'], policy)).rejects.toThrow('grant refused')
    expect(state.grants).toHaveLength(2)
    const failed = state.grants[1]!
    expect(failed.dispose).toHaveBeenCalledOnce()
    expect(existsSync(failed.added[0]!.path)).toBe(false)
    state.failTemp = false
    const retried = await sandbox.confine(['true'], policy)
    expect(state.grants).toHaveLength(3)
    expect(flag(retried.argv, '--temp')).not.toBe(failed.added[0]!.path)
  })

  it('does not reuse cached grants when an extra root disappears', async () => {
    const { sandbox } = await setup()
    const workspaceRoot = scratch()
    const extra = join(workspaceRoot, 'extra')
    mkdirSync(extra)
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot, additionalWorkspaceRoots: [extra], sessionId: SessionId('removed') }
    await sandbox.confine(['true'], policy)
    rmSync(extra, { recursive: true })
    await expect(sandbox.confine(['true'], policy)).rejects.toThrow()
    expect(state.grants).toHaveLength(2)
  })
})
