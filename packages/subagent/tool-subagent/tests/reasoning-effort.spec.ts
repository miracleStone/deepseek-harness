/** Independent child effort selection and its live preflight. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'

const reasoning = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}
const args = { description: 'effort work', prompt: 'Do it.' }
const route = { provider: 'alpha', model: 'parent-model' }

describe('independent subagent reasoning effort', () => {
  it.each([undefined, true, false])('exposes effort independently with enableReasoningEffort=%s', async (enabled) => {
    const ctx = await setup({ provider: 'mock', ...enabled === undefined ? {} : { enableReasoningEffort: enabled } })
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(tool => tool.name === 'subagent')!
    expect(schema.parameters).toHaveProperty('properties.description')
    expect('reasoning_effort' in (schema.parameters as { properties: object }).properties).toBe(enabled !== false)
    expect(schema.parameters).not.toHaveProperty('properties.provider')
    expect(schema.parameters).not.toHaveProperty('properties.model')
    expect(ctx.tools.get('list_subagent_models', modelSelectionSetupAgent(ctx))).toBeUndefined()
    if (enabled !== false) expect(schema.description).toContain('without changing its provider or model')
  })

  it.each([false, true])('accepts effort without naming the inherited authorized route with route policy=%s', async (withModelSelection) => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock', withModelSelection }, { onStart: started })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], reasoning))
    const parent = modelSelectionSetupAgent(ctx)
    parent.session.append('request/header', { header: { config: route }, reason: 'initial' })
    const activation = vi.spyOn(ctx.subagents, 'startActivation')

    const result = await callSubagent(ctx, { ...args, reasoning_effort: 'low' })
    expect(result.isError).toBe(false)
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { reasoningEffort: 'low' } }))
    expect(activation).toHaveBeenCalledOnce()
    const changed = await callSubagent(ctx, { ...args, provider: 'alpha', model: 'outside-allowlist', reasoning_effort: 'low' })
    expect(changed.isError).toBe(true)
    expect(text(changed)).toContain(withModelSelection ? 'is not allowed for this Session' : 'child model selection is disabled')
    expect(activation).toHaveBeenCalledOnce()
  })

  it('rejects effort-only selection when its effective route is outside the Session allowlist', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], reasoning))
    modelSelectionSetupAgent(ctx).session.append('request/header', {
      header: { config: { provider: 'alpha', model: 'outside-allowlist' } }, reason: 'initial',
    })
    const activation = vi.spyOn(ctx.subagents, 'startActivation')
    const result = await callSubagent(ctx, { ...args, reasoning_effort: 'low' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed for this Session')
    expect(activation).not.toHaveBeenCalled()
  })

  it.each([
    { enableReasoningEffort: false, agentOptions: true },
    { enableReasoningEffort: true, agentOptions: false },
  ])('rejects forced effort before activation when unavailable: %j', async ({ enableReasoningEffort, agentOptions }) => {
    const ctx = await setup({ provider: 'mock', enableReasoningEffort }, { capabilities: { agentOptions } })
    const activation = vi.spyOn(ctx.subagents, 'startActivation')
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(tool => tool.name === 'subagent')!
    expect(schema.parameters).not.toHaveProperty('properties.reasoning_effort')
    const forced = await callSubagent(ctx, { ...args, reasoning_effort: 'low' })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('reasoning effort selection is disabled')
    expect(activation).not.toHaveBeenCalled()
    expect((await callSubagent(ctx, args)).isError).toBe(false)
    expect(activation).toHaveBeenCalledOnce()
  })

  it('keeps effort available under route authorization despite the independent opt-out', async () => {
    const ctx = await setup({ provider: 'mock', enableReasoningEffort: false, withModelSelection: true })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], reasoning))
    modelSelectionSetupAgent(ctx).session.append('request/header', { header: { config: route }, reason: 'initial' })
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(tool => tool.name === 'subagent')!
    expect(schema.parameters).toHaveProperty('properties.reasoning_effort')
    expect((await callSubagent(ctx, { ...args, reasoning_effort: 'low' })).isError).toBe(false)
  })

  it('uses current adapter support and rejects invalid effort before activation while omission stays lazy', async () => {
    // A completed child wakes the parent and resolves its own model; keep that separate from child preflight.
    const childWork = Promise.withResolvers<undefined>()
    onTestFinished(() => { childWork.resolve(undefined) })
    const ctx = await setup({ provider: 'mock' }, { onStart: () => childWork.promise })
    const adapter = new MockAdapter([], reasoning)
    const resolve = vi.spyOn(adapter, 'resolveModel')
    const registration = ctx.llm.registerAdapter(['alpha'], adapter)
    modelSelectionSetupAgent(ctx).session.append('request/header', { header: { config: route }, reason: 'initial' })
    const activation = vi.spyOn(ctx.subagents, 'startActivation')
    expect((await callSubagent(ctx, args)).isError).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect((await callSubagent(ctx, { ...args, reasoning_effort: 'low' })).isError).toBe(false)
    registration()
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const invalid = await callSubagent(ctx, { ...args, reasoning_effort: 'low' })
    expect(invalid.isError).toBe(true)
    expect(text(invalid)).toContain('does not support reasoning effort')
    expect(activation).toHaveBeenCalledTimes(2)
  })
})
