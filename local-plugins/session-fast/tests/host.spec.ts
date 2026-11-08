import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'

const adapterApply = vi.hoisted(() => vi.fn())
vi.mock('../adapter.js', () => ({ Config: {}, apply: adapterApply }))
import * as plugin from '../index.js'

type Invocation = { agent: { id: string }; rawInput: string; signal: AbortSignal }
type Command = { recordInput: boolean; handler(input: Invocation): Promise<{ kind: string; text: string }> }
type Route = { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }
const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  adapterApply.mockReset()
  vi.restoreAllMocks()
})

async function boot(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.provide('storageDomain', facility)
  ctx.effect(() => () => facility.closeAll())
  const commands = new Map<string, Command>()
  const executeCommand = vi.fn(() => { throw new Error('Preference RPC must not execute logged commands') })
  ctx.provide('commands', { execute: executeCommand, register: (definition: Command & { name: string }) => {
    commands.set(definition.name, definition)
    return () => { commands.delete(definition.name) }
  } })
  const routes = new Map<string, Route>()
  ctx.provide('connection', { fetch: { register: (route: Route) => {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } })
  const registerTool = vi.fn(() => { throw new Error('Fast controls must not add model tools') })
  ctx.provide('tools', { register: registerTool })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  await plugin.apply(ctx, { providers: { get: () => ({ 'openai-codex': { serviceTier: 'fast' } }) } })
  const signal = new AbortController().signal
  const command = (rawInput: string, id = 'a') => commands.get('fast')!.handler({ rawInput, agent: { id }, signal })
  const tier = (sessionId?: string, provider = 'openai-codex') => ctx.waterfall('llm-pi-ai/service-tier', {
    provider, model: 'test-model', defaultTier: 'fast',
    ...sessionId === undefined ? {} : { sessionId },
  }, () => 'fast')
  const post = async (payload: unknown) => {
    const route = routes.get('/api/session-fast')!
    return route.fetch(new Request('http://host/api/session-fast', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }))
  }
  const state = async (payload: unknown) => {
    const response = await post(payload)
    return response.ok ? response.json() : { status: response.status, ...(await response.json()) }
  }
  return { ctx, pool, facility, commands, command, tier, warn, registerTool, post, state, routes, executeCommand, signal }
}

describe('user-only session Fast controls', () => {
  it('opens the menu repeatedly and writes preferences without executing logged commands', async () => {
    const host = await boot()
    for (let i = 0; i < 3; i++) {
      expect(await host.state({ sessionId: 'a' })).toEqual({ enabled: false })
    }
    expect(await host.state({ sessionId: 'a', enabled: true })).toEqual({ enabled: true })
    expect(await host.state({ sessionId: 'a' })).toEqual({ enabled: true })
    expect(await host.state({ sessionId: 'b' })).toEqual({ enabled: false })
    expect(host.tier('a')).toBe('fast')
    expect(host.executeCommand).not.toHaveBeenCalled()
    expect(host.registerTool).not.toHaveBeenCalled()
  })

  it('rejects invalid bodies and non-JSON payloads without writes', async () => {
    const host = await boot()
    expect(await host.state({ sessionId: 'a', enabled: 'yes' })).toMatchObject({ status: 400, error: { code: 'session-fast/invalid-request' } })
    expect(await host.state({ sessionId: '../a' })).toMatchObject({ status: 400, error: { code: 'session-fast/invalid-request' } })
    expect(await host.state({ sessionId: 'a', extra: true })).toMatchObject({ status: 400, error: { code: 'session-fast/invalid-request' } })
    const malformed = await host.post(undefined)
    expect(malformed.status).toBe(400)
    expect(host.tier('a')).toBe('default')
    expect(host.executeCommand).not.toHaveBeenCalled()
  })

  it('reports failed writes without changing committed preferences', async () => {
    const host = await boot()
    host.pool.failNextWrites = 1
    expect(await host.state({ sessionId: 'a', enabled: true })).toMatchObject({ status: 503, error: { code: 'session-fast/storage-failed' } })
    expect(host.tier('a')).toBe('default')
    expect(host.executeCommand).not.toHaveBeenCalled()
  })

  it('registers no model tool and does not depend on the model tool registry', async () => {
    const host = await boot()
    expect(plugin.inject).not.toContain('tools')
    expect(host.registerTool).not.toHaveBeenCalled()
    expect(adapterApply).toHaveBeenCalledOnce()
  })

  it('preserves the UI command and keeps committed settings isolated by session', async () => {
    const host = await boot()
    expect(await host.command('status')).toEqual({ kind: 'success', text: '{"enabled":false}' })
    expect(await host.command('on')).toEqual({ kind: 'success', text: '{"enabled":true}' })
    expect(host.tier('a')).toBe('fast')
    expect(host.tier('b')).toBe('default')
    expect(await host.command('off')).toEqual({ kind: 'success', text: '{"enabled":false}' })
    expect(host.tier('a')).toBe('default')
    expect(host.commands.get('fast')!.recordInput).toBe(false)
  })

  it.each(['antigravity', 'sinapisai', 'google', 'anthropic', 'openai'])(
    'leaves %s tier resolution and model tools untouched', async (provider) => {
      const host = await boot()
      await host.command('on')
      expect(host.tier('a', provider)).toBe('fast')
      expect(host.registerTool).not.toHaveBeenCalled()
    },
  )

  it('delegates agentless requests to the provider default', async () => {
    const host = await boot()
    await host.command('on')
    expect(host.tier()).toBe('fast')
    expect(host.tier('a')).toBe('fast')
    expect(adapterApply.mock.calls[0]?.[1].providers.get()).toEqual({ 'openai-codex': { serviceTier: 'fast' } })
  })

  it('keeps the previous setting when saving fails', async () => {
    const host = await boot()
    await host.command('on')
    host.pool.failNextWrites = 1
    expect(await host.command('off')).toMatchObject({ kind: 'error' })
    expect(host.tier('a')).toBe('fast')
    expect(host.warn).toHaveBeenCalledOnce()
  })

  it('rejects an invalid user command without changing the setting', async () => {
    const host = await boot()
    expect(await host.command('toggle')).toMatchObject({ kind: 'error' })
    expect(host.tier('a')).toBe('default')
  })

  it('removes the command and closes its domain on disposal', async () => {
    const host = await boot()
    const domain = host.facility.get('codex_session_fast')!
    await host.ctx.fiber.dispose()
    expect(host.commands.size).toBe(0)
    expect(host.routes.size).toBe(0)
    expect(() => domain.table('sessions').get('a')).toThrow(/closed/)
    expect(host.facility.get('codex_session_fast')).toBeUndefined()
  })
})
