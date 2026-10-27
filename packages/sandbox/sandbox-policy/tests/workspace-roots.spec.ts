/** Additional workspace grants and their durable model-visible context. */

import { lstat, mkdir, mkdtemp, realpath, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import SandboxPolicyService, { setSandboxWorkspaceRoots } from '../src/index.ts'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

async function fixture(includeRuntimeContext = true, cwd = resolve('primary')) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeRuntimeContext })
  const policyFiber = await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
  const extra = resolve('shared {{literal}} files')
  const id = SessionId('folders')
  const session = Session.create(id, undefined, {
    id, cwd, version: SESSION_FORMAT_VERSION, isSeeded: false, createdAt: 0,
  })
  const agent = { session } as Agent
  return { ctx, session, agent, cwd, extra, policyFiber }
}

describe('additional workspace roots', () => {
  it('keeps old Sessions single-root and resolves each Session independently', async () => {
    const { ctx, session, cwd, extra } = await fixture()
    expect(ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session })).not.toHaveProperty('additionalWorkspaceRoots')
    setSandboxWorkspaceRoots(session, [cwd, extra, extra])
    expect(ctx.sandboxPolicy.resolve({ session })).toMatchObject({ additionalWorkspaceRoots: [extra] })
    const other = Session.create(SessionId('other'))
    expect(ctx.sandboxPolicy.additionalRootsOf(other)).toEqual([])
    expect(ctx.sandboxPolicy.resolve()).not.toHaveProperty('additionalWorkspaceRoots')
  })

  it('retains deployment grants separately from Session folder permissions and describes both', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    const deployed = resolve('deployment-grant')
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', additionalWritableRoots: [deployed] })
    const cwd = resolve('session-root')
    const extra = resolve('session-extra')
    const id = SessionId('combined-grants')
    const session = Session.create(id, undefined, { id, cwd, version: SESSION_FORMAT_VERSION, isSeeded: false, createdAt: 0 })
    setSandboxWorkspaceRoots(session, [extra])
    expect(ctx.sandboxPolicy.resolve({ session })).toMatchObject({
      workspaceRoot: cwd, additionalWorkspaceRoots: [extra], additionalWritableRoots: [deployed],
    })
    const context = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: { session } as Agent }))
    expect(context).toContain(`these session workspace folders: ${JSON.stringify([cwd, extra])}`)
    expect(context).toContain(`Additional writable directories: ${JSON.stringify([deployed])}`)
    setSandboxWorkspaceRoots(session, [])
    expect(ctx.sandboxPolicy.resolve({ session })).toMatchObject({ additionalWritableRoots: [deployed] })
    expect(ctx.sandboxPolicy.resolve({ session })).not.toHaveProperty('additionalWorkspaceRoots')
  })

  it('retains outer roots in approval order without merging neighboring path prefixes', async () => {
    const primary = resolve('projects', 'main')
    const sibling = resolve('shared')
    const parent = resolve('projects')
    const neighbor = resolve('projects-other')
    const { ctx, session } = await fixture(true, primary)
    setSandboxWorkspaceRoots(session, [join(primary, 'nested'), sibling, parent, neighbor, sibling])
    const recorded = [...ctx.sandboxPolicy.additionalRootsOf(session)]
    expect(ctx.sandboxPolicy.resolve({ session })).toMatchObject({
      workspaceRoot: sibling, additionalWorkspaceRoots: [parent, neighbor],
    })
    expect(session.header.cwd).toBe(primary)
    expect(ctx.sandboxPolicy.additionalRootsOf(session)).toEqual(recorded)
  })

  it('keeps case-distinct POSIX execution-world roots separate on every Host', async () => {
    const { ctx, session } = await fixture(true, '/Project')
    setSandboxWorkspaceRoots(session, ['/project/shared', '/Project/nested'])
    expect(ctx.sandboxPolicy.resolve({ session })).toMatchObject({
      workspaceRoot: '/Project', additionalWorkspaceRoots: ['/project/shared'],
    })
  })

  it('separates POSIX and UNC roots and retains the first equivalent Windows spelling from durable data', async () => {
    const { ctx, session } = await fixture(true, '/Project')
    const windowsRoot = '//Server/Share/Project'
    const otherServer = '//Other/Share/Project'
    const restored = Session.create(session.id, [{
      type: 'sandbox/workspace-roots', seq: SessionSeq(0), time: 0,
      data: { additionalWorkspaceRoots: [windowsRoot, '//server/share/project', otherServer, '/Project/nested'] },
    }], session.header)
    expect(ctx.sandboxPolicy.resolve({ session: restored })).toMatchObject({
      workspaceRoot: '/Project', additionalWorkspaceRoots: [windowsRoot, otherServer],
    })
  })

  it.each(['extra-inside-primary', 'primary-inside-extra'] as const)(
    'does not grant a junction target when an approved %s root is retargeted', async (arrangement) => {
      const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-policy-roots-'))
      const coveringInput = join(directory, 'approved')
      const nestedInput = join(coveringInput, 'nested')
      const outsideInput = join(directory, 'not-approved')
      onTestFinished(async () => {
        const nested = await lstat(nestedInput).catch((reason: unknown) => {
          if (reason instanceof Error && 'code' in reason && reason.code === 'ENOENT') return undefined
          throw reason
        })
        if (nested?.isSymbolicLink() === true) await unlink(nestedInput)
        await rm(directory, { recursive: true, force: true })
      })
      assertWorkspaceOutsideTemp(directory)
      await mkdir(nestedInput, { recursive: true })
      await mkdir(outsideInput)
      const covering = await realpath(coveringInput)
      const nested = await realpath(nestedInput)
      const outside = await realpath(outsideInput)
      const primary = arrangement === 'extra-inside-primary' ? covering : nested
      const extra = arrangement === 'extra-inside-primary' ? nested : covering
      const { ctx, session, agent } = await fixture(true, primary)
      setSandboxWorkspaceRoots(session, [extra])
      const recordedSeq = session.seq
      const before = ctx.sandboxPolicy.resolve({ session })
      expect(before.workspaceRoot).toBe(covering)
      expect([primary, extra]).toContain(before.workspaceRoot)
      expect(before).not.toHaveProperty('additionalWorkspaceRoots')

      await rmdir(nested)
      await symlink(outside, nested, 'junction')
      expect(await realpath(nested)).toBe(outside)
      const after = ctx.sandboxPolicy.resolve({ session })
      expect(after).toEqual(before)
      expect(writableRoots(after)).toEqual(writableRoots({ mode: 'workspace-write', workspaceRoot: covering }))
      expect(writableRoots(after)).not.toContain(outside)
      // Direct policy aliases retain their separate Host-owned behavior.
      expect(writableRoots({ mode: 'workspace-write', workspaceRoot: primary, additionalWorkspaceRoots: [extra] }))
        .toContain(outside)
      expect(session.header.cwd).toBe(primary)
      expect(ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([extra])
      expect(session.seq).toBe(recordedSeq)
      const context = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent }))
      expect(context).toContain(`Session workspace folders: ${JSON.stringify([primary, extra])}`)
    },
  )

  it('replays the complete root list and clears it without changing mode or cwd', async () => {
    const { ctx, session, extra } = await fixture()
    setSandboxWorkspaceRoots(session, [extra])
    const resumed = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(ctx.sandboxPolicy.additionalRootsOf(resumed)).toEqual([extra])
    setSandboxWorkspaceRoots(resumed, [])
    expect(ctx.sandboxPolicy.additionalRootsOf(resumed)).toEqual([])
    expect(ctx.sandboxPolicy.resolve({ session: resumed })).toMatchObject({ mode: 'workspace-write' })
    expect(resumed.header).toEqual(session.header)
    expect(ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([extra])
  })

  it('rejects a relative root without appending or changing grants', async () => {
    const { ctx, session, extra } = await fixture()
    setSandboxWorkspaceRoots(session, [extra])
    const before = session.seq
    expect(() => { setSandboxWorkspaceRoots(session, [extra, 'relative/folder']) }).toThrow('must be absolute')
    expect(session.seq).toBe(before)
    expect(ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([extra])
  })

  it('rejects relative roots replayed from durable Session events before resolving grants', async () => {
    const { ctx, session } = await fixture()
    const restored = Session.create(session.id, [{
      type: 'sandbox/workspace-roots', seq: SessionSeq(0), time: 0,
      data: { additionalWorkspaceRoots: ['relative/folder'] },
    }], session.header)
    expect(() => ctx.sandboxPolicy.resolve({ session: restored })).toThrow('must be absolute')
    expect(() => ctx.sandboxPolicy.additionalRootsOf(restored)).toThrow('must be absolute')
  })

  it('keeps the first equivalent absolute root when restoring noncanonical durable spellings', async () => {
    const { ctx, session, cwd } = await fixture()
    const equivalent = cwd + sep
    const restored = Session.create(session.id, [{
      type: 'sandbox/workspace-roots', seq: SessionSeq(0), time: 0,
      data: { additionalWorkspaceRoots: [equivalent, cwd] },
    }], session.header)
    const policy = ctx.sandboxPolicy.resolve({ session: restored })
    expect(policy.workspaceRoot).toBe(cwd)
    expect(policy).not.toHaveProperty('additionalWorkspaceRoots')
    expect(ctx.sandboxPolicy.additionalRootsOf(restored)).toEqual([equivalent, cwd])
  })

  it('initializes folders after Session announcement during writable setup', async () => {
    const { ctx, session, extra } = await fixture()
    ctx.emit('session/created', session)
    ctx.sandboxPolicy.initializeWorkspaceRoots(session, [extra])
    expect(ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([extra])
    expect(ctx.sandboxPolicy.resolve({ session })).toMatchObject({ additionalWorkspaceRoots: [extra] })
  })

  it('records initial grants once and avoids empty events on single-folder creation', async () => {
    const { ctx, session, extra } = await fixture()
    ctx.sandboxPolicy.initializeWorkspaceRoots(session, [])
    expect(session.snapshotEvents()).toEqual([])
    ctx.sandboxPolicy.initializeWorkspaceRoots(session, [extra])
    ctx.sandboxPolicy.initializeWorkspaceRoots(session, [extra])
    expect(session.snapshotEvents()).toHaveLength(1)
    expect(session.snapshotEvents()[0]).toMatchObject({
      type: 'sandbox/workspace-roots', data: { additionalWorkspaceRoots: [extra] },
    })
  })

  it('retains its root reader after unregistering without using deprecated keyed reads', async () => {
    const { ctx, session, extra, policyFiber } = await fixture()
    const owner = ctx.sandboxPolicy
    const read = vi.spyOn(ctx.sessionProjections, 'stateOf')
    onTestFinished(() => { read.mockRestore() })
    await policyFiber.dispose()
    setSandboxWorkspaceRoots(session, [extra])
    expect(owner.additionalRootsOf(session)).toEqual([extra])
    expect(owner.resolve({ session })).toMatchObject({ additionalWorkspaceRoots: [extra] })
    expect(read).not.toHaveBeenCalled()
    expect(ctx.sessionProjections.checkpoint(session)).toMatchObject({
      sandboxWorkspaceRoots: { ver: 1, seq: 0, val: [extra] },
    })
  })

  it('includes the configured primary root in folder context for a legacy Session without cwd', async () => {
    const { ctx, extra } = await fixture(false)
    const session = Session.create(SessionId('legacy-folders'))
    setSandboxWorkspaceRoots(session, [extra])
    const context = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: { session } as Agent }))
    expect(context).toContain(`Session workspace folders: ${JSON.stringify([ctx.sandboxPolicy.workspaceRoot, extra])}`)
  })

  it('keeps folder context when optional runtime context is disabled', async () => {
    const { ctx, session, agent, cwd, extra } = await fixture(false)
    setSandboxWorkspaceRoots(session, [extra])
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(renderContextSnapshot(assembly)).toContain(`Session workspace folders: ${JSON.stringify([cwd, extra])}`)
    expect(renderContextSnapshot(assembly)).toContain('{{literal}}')
    expect(renderPrompt(assembly)).not.toContain(extra)
  })

  it('describes all workspace-write folders and removes both contributions on disposal', async () => {
    const { ctx, session, agent, extra, policyFiber } = await fixture()
    setSandboxWorkspaceRoots(session, [extra])
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(renderContextSnapshot(assembly)).toContain('may modify files under these session workspace folders:')
    expect(renderContextSnapshot(assembly)).toContain(extra.replaceAll('\\', '\\\\'))
    expect(renderPrompt(assembly)).not.toContain(extra)
    expect((await ctx.systemPrompt.assemble()).contexts.every(context => context.text === '')).toBe(true)
    await policyFiber.dispose()
    expect((await ctx.systemPrompt.assemble({ agent })).contexts).toEqual([])
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
  })
})
