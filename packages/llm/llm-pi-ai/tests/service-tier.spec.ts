/** Codex service tiers through the real pi-ai serializer and a loopback provider. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

// Codex requires the account claim before it sends any request to the local fixture.
const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'tier-test-account' } })).toString('base64url')
const token = `e30.${payload}.fixture`
const item = { type: 'message', id: 'msg_tier', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
const completed = [
  JSON.stringify({ type: 'response.created', response: { id: 'resp_tier' } }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }),
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }),
  JSON.stringify({ type: 'response.completed', response: {
    id: 'resp_tier', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  } }),
]
const request: GenerateOptions = { provider: 'openai-codex', model: 'gpt-5.5', messages: [] }

afterEach(closeMockServers)

function profile(baseURL: string, serviceTier?: 'default' | 'fast'): PiAiProviderProfile {
  return {
    baseURL, apiKeyEnv: 'PI_SERVICE_TIER_TEST_KEY', transport: 'sse', models: [{ id: 'gpt-5.5' }], reasoning: 'high',
    ...serviceTier === undefined ? {} : { serviceTier },
  }
}

function adapterFor(profiles: () => ReturnType<typeof resolveProfiles>): PiAiAdapter {
  return new PiAiAdapter({ profiles, resolveApiKey: () => Promise.resolve(token), auth: memoryAuth() })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Codex service tier requests', () => {
  it('isolates session tiers and captures a dispatched tier before waiting for credentials', async () => {
    const server = await mockServer(Array.from({ length: 3 }, () => ({ events: completed })))
    const profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'fast') })
    const tiers = new Map<string, 'fast' | 'default'>([['session-a', 'fast']])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      auth: memoryAuth(),
      resolveServiceTier: input => Promise.resolve(tiers.get(input.sessionId ?? '') ?? input.defaultTier),
      resolveApiKey: async () => { entered.resolve(undefined); await release.promise; return token },
    })
    const pending = collect(adapter.stream({ ...request, sessionId: SessionId('session-a') }))
    try {
      await entered.promise
      tiers.set('session-a', 'default')
    } finally { release.resolve(undefined) }
    await pending
    await collect(adapter.stream({ ...request, sessionId: SessionId('session-a') }))
    await collect(adapter.stream({ ...request, sessionId: SessionId('session-b') }))
    expect(server.requests.map(body => (body as { service_tier?: string }).service_tier))
      .toEqual(['priority', 'default', 'priority'])
    for (const body of server.requests) expect(body).toHaveProperty('reasoning.effort', 'high')
  })

  it('fails a tier resolution before sending a request', async () => {
    const server = await mockServer([{ events: completed }])
    const profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'fast') })
    const adapter = new PiAiAdapter({
      profiles: () => profiles, auth: memoryAuth(),
      resolveApiKey: () => Promise.resolve(token),
      resolveServiceTier: () => Promise.reject(new Error('tier store unavailable')),
    })
    await expect(collect(adapter.stream(request))).rejects.toThrow('tier store unavailable')
    expect(server.requests).toHaveLength(0)
  })

  it.each([
    { configured: undefined, wire: undefined },
    { configured: 'default', wire: 'default' },
    { configured: 'fast', wire: 'priority' },
  ] as const)('serializes $configured as $wire without changing high reasoning', async ({ configured, wire }) => {
    const server = await mockServer([{ events: completed }])
    const profiles = resolveProfiles({ 'openai-codex': profile(server.url, configured) })
    const chunks = await collect(adapterFor(() => profiles).stream(request))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-5.5' },
      blocks: [{ type: 'text' }],
    } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    })
    expect(server.requests).toHaveLength(1)
    expect(server.paths).toEqual(['/codex/responses'])
    expect(server.requests[0]).toMatchObject({ model: 'gpt-5.5', reasoning: { effort: 'high' } })
    if (wire === undefined) expect(server.requests[0]).not.toHaveProperty('service_tier')
    else expect(server.requests[0]).toHaveProperty('service_tier', wire)
    expect(server.requests[0]).not.toHaveProperty('service_tier', 'fast')
    expect(server.requests[0]).not.toHaveProperty('serviceTier')
  })

  it.each(['default', 'fast'] as const)('keeps a request-level high effort with explicit %s tier', async (serviceTier) => {
    const server = await mockServer([{ events: completed }])
    const profiles = resolveProfiles({ 'openai-codex': { ...profile(server.url, serviceTier), reasoning: 'low' } })
    const chunks = await collect(adapterFor(() => profiles).stream({ ...request, reasoningEffort: ReasoningEffortId('high') }))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests[0]).toMatchObject({ reasoning: { effort: 'high' } })
  })

  it.each([
    { serviceTier: 'default', reasoning: undefined },
    { serviceTier: 'default', reasoning: 'off' },
    { serviceTier: 'fast', reasoning: undefined },
    { serviceTier: 'fast', reasoning: 'off' },
  ] as const)('preserves simple-path reasoning for $serviceTier with reasoning $reasoning', async ({ serviceTier, reasoning }) => {
    const server = await mockServer([{ events: completed }, { events: completed }])
    const baselineProfile = profile(server.url)
    delete baselineProfile.reasoning
    if (reasoning !== undefined) baselineProfile.reasoning = reasoning
    let profiles = resolveProfiles({ 'openai-codex': baselineProfile })
    const adapter = adapterFor(() => profiles)
    const baselineChunks = await collect(adapter.stream(request))
    profiles = resolveProfiles({ 'openai-codex': { ...baselineProfile, serviceTier } })
    const chunks = await collect(adapter.stream(request))

    expect(baselineChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]).not.toHaveProperty('service_tier')
    expect(server.requests[1]).toHaveProperty('service_tier', serviceTier === 'fast' ? 'priority' : 'default')
    const bodies = server.requests as { reasoning?: unknown }[]
    expect(bodies[1]?.reasoning).toEqual(bodies[0]?.reasoning)
  })

  it('freezes an explicit tier in prepared calls while later calls use updated profiles', async () => {
    const server = await mockServer(Array.from({ length: 3 }, () => ({ events: completed })))
    let profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'fast') })
    const adapter = adapterFor(() => profiles)
    const prepared = await adapter.prepareCall(request.provider, request.model)
    profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'default') })

    await collect(prepared.stream(request))
    await collect(adapter.stream(request))
    profiles = resolveProfiles({ 'openai-codex': profile(server.url) })
    await collect(adapter.stream(request))

    expect(server.requests).toHaveLength(3)
    expect(server.requests[0]).toHaveProperty('service_tier', 'priority')
    expect(server.requests[1]).toHaveProperty('service_tier', 'default')
    expect(server.requests[2]).not.toHaveProperty('service_tier')
    for (const body of server.requests) expect(body).toHaveProperty('reasoning.effort', 'high')
  })

  it('closes the explicit-tier SDK request when the caller cancels', async () => {
    const server = await mockServer([{ holdOpen: true }])
    const profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'fast') })
    const ctx = new Context()
    const runtime = await ctx.plugin(LlmRuntime)
    const unregister = ctx.llm.registerAdapter(['openai-codex'], adapterFor(() => profiles))
    const controller = new AbortController()
    try {
      const pending = collect(ctx.llm.stream({ ...request, signal: controller.signal }))
      await server.requestReceived
      expect(server.closedResponses).toBe(0)
      controller.abort('fixture cancellation')
      const chunks = await pending

      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
      await server.responseClosed
      expect(server.closedResponses).toBe(1)
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]).toHaveProperty('service_tier', 'priority')
    } finally {
      controller.abort()
      unregister()
      await runtime.dispose()
    }
  })

  it('closes the explicit-tier SDK request when its consumer stops early', async () => {
    const server = await mockServer([{ events: completed.slice(0, 3), holdOpen: true }])
    const profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'fast') })
    const controller = new AbortController()
    try {
      for await (const chunk of adapterFor(() => profiles).stream({ ...request, signal: controller.signal })) {
        expect(chunk).toHaveProperty('type')
        break
      }
      await server.responseClosed
      expect(server.closedResponses).toBe(1)
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]).toHaveProperty('service_tier', 'priority')
    } finally { controller.abort() }
  })

  it.each([400, 403, 429, 503])('reports HTTP %s without retrying at a lower tier', async (status) => {
    const server = await mockServer([
      { status, body: JSON.stringify({ error: { message: 'priority tier unavailable' } }) },
      { events: completed },
    ])
    const profiles = resolveProfiles({ 'openai-codex': profile(server.url, 'fast') })
    const chunks = await collect(adapterFor(() => profiles).stream(request))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toHaveProperty('service_tier', 'priority')
  })
})
