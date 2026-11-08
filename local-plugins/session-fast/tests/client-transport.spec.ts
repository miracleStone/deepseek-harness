import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type State = { enabled: boolean }
type Frame = { ok: boolean; value?: State }
type Resource = { open(address: string, context: { signal: AbortSignal }): AsyncGenerator<Frame> }
type Actions = { save(id: string, enabled: boolean): Promise<State>; refresh(id: string): Promise<State> }

describe('Fast UI preference transport', () => {
  it('reads on repeated dropdown opens and saves without invoking commands', async () => {
    const values = new Map<string, boolean>()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { sessionId: string; enabled?: boolean }
      if (payload.enabled !== undefined) values.set(payload.sessionId, payload.enabled)
      return Response.json({ enabled: values.get(payload.sessionId) ?? false })
    })
    let provider: Resource | undefined
    let actions: Actions | undefined
    const disposers: Array<() => void> = []
    const context = {
      locale: { register: () => () => {} },
      effect: (setup: () => (() => void)) => { disposers.push(setup()) },
      resources: { register: (resource: Resource) => { provider = resource; return () => {} } },
      slots: {
        inject: (_name: string, setup: () => (() => void)) => { disposers.push(setup()) },
        register: (options: { inject?: () => Actions }) => { if (options.inject) actions = options.inject(); return () => {} },
      },
    }
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: (definition: {
        factory(require: (name: string) => object): { inject: string[]; apply(ctx: typeof context): void }
      }) => {
        const plugin = definition.factory(name => {
          expect(name).toBe('react')
          return { createElement: () => null }
        })
        expect(plugin.inject).not.toContain('remote')
        expect(plugin.inject).not.toContain('connection')
        plugin.apply(context)
      } } },
      URL, AbortController, Response, fetch: fetchMock,
    })
    try {
      expect(provider).toBeDefined()
      for (let i = 0; i < 3; i++) {
        const controller = new AbortController()
        const stream = provider!.open('dsh-resource://session-fast/session-a', { signal: controller.signal })
        expect((await stream.next()).value).toEqual({ ok: true, value: { enabled: false } })
        controller.abort()
        await stream.return(undefined)
      }
      await expect(actions!.save('session-a', true)).resolves.toEqual({ enabled: true })
      await expect(actions!.refresh('session-a')).resolves.toEqual({ enabled: true })
      await expect(actions!.refresh('session-b')).resolves.toEqual({ enabled: false })
      const controller = new AbortController()
      const stream = provider!.open('dsh-resource://session-fast/session-a', { signal: controller.signal })
      try {
        expect((await stream.next()).value).toEqual({ ok: true, value: { enabled: true } })
        await actions!.save('session-a', false)
        expect((await stream.next()).value).toEqual({ ok: true, value: { enabled: false } })
        await actions!.save('session-a', true)
        expect((await stream.next()).value).toEqual({ ok: true, value: { enabled: true } })
      } finally {
        controller.abort()
        await stream.return(undefined)
      }
      expect(fetchMock).toHaveBeenCalledTimes(9)
      for (const [url, init] of fetchMock.mock.calls) {
        expect(url).toBe('/api/session-fast')
        expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
      }
    } finally {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
})
