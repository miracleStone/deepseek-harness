/** Loader-configured tools exercise real local spawn and fork child requests. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReasoningEffortId, ToolCallId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as spawn from '../../subagent-spawn-in-process/src/index.ts'
import * as fork from '../../subagent-fork-in-process/src/index.ts'
import { mountLocalActivations } from '../../subagent/tests/local-activation.ts'
import * as tool from '../src/index.ts'

const reasoning = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

describe('child effort Loader composition', () => {
  it.each([
    { provider: 'spawn', changeRoute: false },
    { provider: 'fork', changeRoute: false },
    { provider: 'spawn', changeRoute: true },
    { provider: 'fork', changeRoute: true },
  ] as const)('applies effort to the actual $provider request and logged header (changeRoute=$changeRoute)', async ({ provider, changeRoute }) => {
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'dsh-effort-loader-'))
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await mountAgentLoopTestDependencies(ctx)
    await mountLocalActivations(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.spawn = spawn
    ctx.loader.builtins.fork = fork
    ctx.loader.builtins.delegation = tool
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      `- name: cordis:${provider}`,
      '  config:',
      `    providerName: ${provider}`,
      '- name: cordis:delegation',
      '  config:',
      `    provider: ${provider}`,
      '    maxDepth: 1',
      ...changeRoute ? ['    modelSelection: true'] : [],
      '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const adapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('done')), reasoning)
    ctx.llm.registerAdapter(['alpha'], adapter)
    const selectedAdapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('selected route done')), {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
      defaultEffort: ReasoningEffortId('low'),
    })
    ctx.llm.registerAdapter(['beta'], selectedAdapter)
    const childAdapter = changeRoute ? selectedAdapter : adapter
    const expectedRoute = changeRoute
      ? { provider: 'beta', model: 'child-model' }
      : { provider: 'alpha', model: 'parent-model' }
    const parent = await ctx.agents.create({
      sessionId: SessionId(`effort-loader-parent-${provider}`),
      agentOptions: { provider: 'alpha', model: 'parent-model', reasoningEffort: ReasoningEffortId('high') },
    })
    if (changeRoute) parent.agent.session.append('subagent/model-selection-policy', { allowedModels: [expectedRoute] })
    const children: Agent[] = []
    const headers: LlmCallConfig[] = []
    ctx.on('agent/created', ({ agent }) => { if (agent.id !== parent.agent.id) children.push(agent) })
    ctx.on('session/event', (session, event) => {
      if (session.header.origin === 'subagent' && session.header.parentSession === parent.agent.id
        && event.type === 'request/header') {
        headers.push(event.data.header.config)
      }
    })
    const activation = vi.spyOn(ctx.subagents, 'startActivation')
    expect(ctx.tools.schemas(parent.agent).find(schema => schema.name === 'subagent')?.parameters)
      .toHaveProperty('properties.reasoning_effort')
    expect(ctx.tools.get('list_subagent_models', parent.agent)).toBeUndefined()
    const result = await executeModelToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`effort-loader-${provider}`),
      name: 'subagent',
      agent: parent.agent,
      arguments: { description: 'low effort child', prompt: 'Answer briefly.',
        ...changeRoute ? expectedRoute : { reasoning_effort: 'low' } },
    })
    expect(result.isError).toBe(false)
    expect(activation).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(children).toHaveLength(1)
      expect(headers.length).toBeGreaterThanOrEqual(1)
      expect(childAdapter.requests.length).toBeGreaterThanOrEqual(1)
    })
    expect(childAdapter.requests[0]).toMatchObject({ ...expectedRoute, reasoningEffort: 'low' })
    expect(headers.at(-1)).toMatchObject({ ...expectedRoute, reasoningEffort: 'low' })
    expect(parent.agent.options.reasoningEffort).toBe('high')
  })
})
