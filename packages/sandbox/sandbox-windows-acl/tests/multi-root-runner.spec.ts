/** Native multi-root access checks through the real Windows runner and local provider. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AclWriteGrant, tempWriteSid, workspaceWriteSid } from '../src/index.ts'

const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))
const runnerInvocation = [process.execPath, '--import', 'tsx/esm', runnerEntry]
const timeout = Math.max(60_000, Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS ?? 0))
const disposers: Array<() => Promise<void>> = []
const scratchDirs: string[] = []
const links: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const link of links.splice(0)) unlinkSync(link)
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-multi-runner-')))
  scratchDirs.push(scratch)
  const workspace = join(scratch, 'workspace')
  const extra = join(scratch, 'extra')
  const temp = join(scratch, 'temp')
  for (const root of [workspace, extra, temp]) mkdirSync(root)
  return { scratch, workspace, extra, temp }
}

function run(argv: readonly string[]) {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

function runRunner(args: readonly string[]) {
  return run([...runnerInvocation, ...args])
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name)
  expect(index).toBeGreaterThan(-1)
  return argv[index + 1]!
}

const writeProbe = [
  "const fs = require('node:fs');",
  'for (const path of process.argv.slice(1)) {',
  "try { fs.writeFileSync(path, 'written'); console.log('OK'); } catch { console.log('DENIED'); }",
  '}',
].join('')

describe.skipIf(process.platform !== 'win32')('Windows multi-root runner', () => {
  it('grants repeated canonical workspace roots, grants none under read-only, and drops removed roots', () => {
    const { scratch, workspace, extra, temp } = fixture()
    const alias = join(scratch, 'extra-alias')
    symlinkSync(extra, alias, 'junction')
    links.push(alias)
    const args = ['--workspace', workspace, '--workspace', alias, '--workspace', workspace, '--workspace', extra, '--temp', temp]
    const first = [join(workspace, 'first.txt'), join(extra, 'first.txt'), join(scratch, 'escaped.txt')]
    const writable = runRunner([...args, '--mode', 'workspace-write', '--', process.execPath, '-e', writeProbe, ...first])
    expect(writable.status, writable.stderr).toBe(0)
    expect(writable.stdout.trim().split(/\r?\n/u)).toEqual(['OK', 'OK', 'DENIED'])
    expect(first.map(path => existsSync(path))).toEqual([true, true, false])

    const readOnlyTargets = [join(workspace, 'readonly.txt'), join(extra, 'readonly.txt'), join(temp, 'readonly.txt')]
    const readOnly = runRunner([...args, '--mode', 'read-only', '--', process.execPath, '-e', writeProbe, ...readOnlyTargets])
    expect(readOnly.status, readOnly.stderr).toBe(0)
    expect(readOnly.stdout.trim().split(/\r?\n/u)).toEqual(['DENIED', 'DENIED', 'DENIED'])
    expect(readOnlyTargets.every(path => !existsSync(path))).toBe(true)

    const narrowedTargets = [join(workspace, 'narrowed.txt'), join(extra, 'narrowed.txt')]
    const narrowed = runRunner([
      '--workspace', workspace, '--temp', temp, '--mode', 'workspace-write',
      '--', process.execPath, '-e', writeProbe, ...narrowedTargets,
    ])
    expect(narrowed.status, narrowed.stderr).toBe(0)
    expect(narrowed.stdout.trim().split(/\r?\n/u)).toEqual(['OK', 'DENIED'])
    expect(narrowedTargets.map(path => existsSync(path))).toEqual([true, false])
  }, timeout)

  it('isolates session temp capabilities while sharing a set SID and leaves only standing workspace grants on disposal', async () => {
    const { workspace, extra } = fixture()
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSandboxProvider, {})
    disposers.push(async () => { await fiber.dispose() })
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals.windowsAclRunnerArgs = runnerInvocation
    const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace, additionalWorkspaceRoots: [extra] }
    const first = await sandbox.confine([process.execPath, '-e', ''], { ...policy, sessionId: SessionId('first') })
    const second = await sandbox.confine([process.execPath, '-e', ''], {
      ...policy, workspaceRoot: extra, additionalWorkspaceRoots: [workspace, extra], sessionId: SessionId('second'),
    })
    const tempA = flag(first.argv, '--temp')
    const tempB = flag(second.argv, '--temp')
    expect(tempA).not.toBe(tempB)
    expect(flag(first.argv, '--write-sid')).toBe(workspaceWriteSid([workspace, extra]))
    expect(flag(second.argv, '--write-sid')).toBe(flag(first.argv, '--write-sid'))
    expect(flag(second.argv, '--temp-write-sid')).not.toBe(flag(first.argv, '--temp-write-sid'))
    const ownFile = join(tempA, 'own.txt')
    const argsA = first.argv.slice(0, first.argv.indexOf('--') + 1)
    const resultA = run([...argsA, process.execPath, '-e', writeProbe, join(workspace, 'a.txt'), join(extra, 'a.txt'), ownFile, join(tempB, 'escape.txt')])
    expect(resultA.status, resultA.stderr).toBe(0)
    expect(resultA.stdout.trim().split(/\r?\n/u)).toEqual(['OK', 'OK', 'OK', 'DENIED'])
    const argsB = second.argv.slice(0, second.argv.indexOf('--') + 1)
    const resultB = run([...argsB, process.execPath, '-e', writeProbe, join(tempB, 'own.txt'), ownFile, join(tempA, 'escape.txt')])
    expect(resultB.status, resultB.stderr).toBe(0)
    expect(resultB.stdout.trim().split(/\r?\n/u)).toEqual(['OK', 'DENIED', 'DENIED'])
    expect(existsSync(join(tempB, 'escape.txt'))).toBe(false)
    expect(existsSync(join(tempA, 'escape.txt'))).toBe(false)

    await fiber.dispose()
    expect(existsSync(tempA)).toBe(false)
    expect(existsSync(tempB)).toBe(false)
    for (const root of [workspace, extra]) {
      const acl = spawnSync('icacls', [root], { encoding: 'utf8' })
      expect(acl.status, acl.stderr).toBe(0)
      expect(acl.stdout).toContain(workspaceWriteSid([workspace, extra]))
    }
  }, timeout)

  it('validates every repeated root and the entire set SID before launching the command', () => {
    const { scratch, workspace, extra, temp } = fixture()
    const file = join(scratch, 'file.txt')
    const marker = join(workspace, 'command-ran.txt')
    writeFileSync(file, 'not a directory')
    const invalidRoots = [join(scratch, 'missing'), 'relative', '', file, '\\root-relative']
    for (const mode of ['read-only', 'workspace-write']) {
      for (const root of invalidRoots) {
        const result = runRunner([
          '--workspace', root, '--workspace', workspace, '--workspace', extra,
          '--temp', temp, '--mode', mode,
          '--', process.execPath, '-e', writeProbe, marker,
        ])
        expect(result.status, `${mode}: ${root}: ${result.stderr}`).toBe(127)
        expect(result.stderr).toContain('windows-acl-run: ')
        expect(existsSync(marker)).toBe(false)
      }
    }
    const wrongSet = runRunner([
      '--workspace', workspace, '--workspace', extra, '--temp', temp, '--mode', 'workspace-write',
      '--write-sid', workspaceWriteSid(workspace), '--temp-write-sid', tempWriteSid(temp),
      '--', process.execPath, '-e', writeProbe, marker,
    ])
    expect(wrongSet.status, wrongSet.stderr).toBe(127)
    expect(wrongSet.stderr).toContain('--write-sid does not match --workspace')
    expect(existsSync(marker)).toBe(false)
  }, timeout)

  it('rejects a temp root inside any additional workspace before applying grants', () => {
    const { workspace, extra, temp } = fixture()
    const marker = join(workspace, 'command-ran.txt')
    const result = runRunner([
      '--workspace', workspace, '--workspace', extra, '--workspace', temp,
      '--temp', temp, '--mode', 'workspace-write',
      '--', process.execPath, '-e', writeProbe, marker,
    ])
    expect(result.status, result.stderr).toBe(127)
    expect(result.stderr).toContain('temp root must be outside the workspace')
    expect(existsSync(marker)).toBe(false)
    const acl = spawnSync('icacls', [workspace], { encoding: 'utf8' })
    expect(acl.status, acl.stderr).toBe(0)
    expect(acl.stdout).not.toContain(workspaceWriteSid([workspace, extra, temp]))
  }, timeout)

  it('revokes every root belonging to one revocable set grant', () => {
    const { workspace, extra } = fixture()
    const sid = workspaceWriteSid([workspace, extra])
    const grant = AclWriteGrant.create(sid)
    try {
      for (const root of [workspace, extra]) grant.add(root)
    } finally {
      grant.dispose()
    }
    for (const root of [workspace, extra]) {
      const acl = spawnSync('icacls', [root], { encoding: 'utf8' })
      expect(acl.status, acl.stderr).toBe(0)
      expect(acl.stdout).not.toContain(sid)
    }
  }, timeout)
})
