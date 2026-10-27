/** Descriptor-backed identity remains complete across live reads and persisted projection caches. */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { snapshotSubagentDescriptor } from '../src/descriptor.ts'
import { subagentIdentityProjectionDefinition } from '../src/projection.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const identity = await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const session = ctx.sessions.create(SessionId('identity-projection'))
  const start = session.append('turn/start', { turn: 1 })
  const descriptor = session.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'continuable', provider: 'spawn', label: 'child',
    agentModel: 'child-model', agentReasoningEffort: ReasoningEffortId('high'),
  }))
  const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const events = [start, descriptor, end]
  const expected = { mode: 'continuable', label: 'child', seq: 1, model: 'child-model', reasoningEffort: 'high' }
  return { ctx, registry: ctx.sessionProjections, identity, session, events, end, expected }
}

describe('subagent identity projection recovery', () => {
  it('projects explicit model and reasoning effort from the descriptor without synthesizing defaults', async () => {
    const { registry, session, expected } = await fixture()
    expect(registry.snapshot(session).values.subagent).toEqual(expected)
    session.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'default route' }))
    expect(registry.snapshot(session).values.subagent).toEqual({ mode: 'continuable', label: 'default route', seq: 3 })
  })

  it('discards version 2 checkpoints that cannot carry descriptor model selection', async () => {
    const { registry, session, events, end, expected } = await fixture()
    const old: ProjectionCheckpoint = {
      subagent: { ver: 2, seq: end.seq, val: { identity: { mode: 'continuable', label: 'child', seq: 1 } } },
    }
    expect(registry.viewCheckpoint(old)).toEqual({})
    expect(registry.restoreFloor(old)).toBe(0)
    const full = registry.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    const restored = registry.restore(old, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(restored).toEqual(full)
    expect(restored.snapshot.values.subagent).toEqual(expected)
    expect(restored.checkpoint['subagent']?.ver).toBe(3)
    expect(() => registry.restore(old, [end], SessionLogOffset(2), session.header, session.inheritedEventCount))
      .toThrow('re-read from seq 0')
  })

  it('restores current checkpoints with an unrelated suffix exactly like complete replay', async () => {
    const { registry, session, events, end, expected } = await fixture()
    const checkpoint = registry.checkpoint(session)
    expect(registry.viewCheckpoint(checkpoint).subagent).toEqual(expected)
    const suffix = session.append('turn/start', { turn: 2 })
    const floor = registry.restoreFloor(checkpoint)
    expect(floor).toBe(2)
    const cached = registry.restore(checkpoint, [end, suffix], SessionLogOffset(2), session.header, session.inheritedEventCount)
    const full = registry.restore({}, [...events, suffix], SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(cached).toEqual(full)
    expect(cached.snapshot.values.subagent).toEqual(expected)
    expect(registry.snapshot(session).values.subagent).toEqual(expected)
  })

  it('hydrates a prepared Session from a checkpoint and retains model selection through publication and unregister', async () => {
    const { ctx, registry, session, events, end, identity, expected } = await fixture()
    const checkpoint = registry.checkpoint(session)
    const prepared = Session.create(session.id, events, session.header, session.inheritedEventCount)
    const hydrated = registry.hydrate(prepared, checkpoint, [end], SessionLogOffset(2))
    expect(hydrated.values.subagent).toEqual(expected)
    ctx.emit('session/created', prepared)
    expect(registry.snapshot(prepared).values.subagent).toEqual(expected)
    await identity.dispose()
    expect(registry.snapshot(prepared).values.subagent).toBeUndefined()
    expect(identity.stateOf(prepared)).toEqual({ identity: expected })
    expect(registry.checkpoint(prepared)).not.toHaveProperty('subagent')
  })
})
