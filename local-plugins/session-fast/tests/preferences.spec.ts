import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { preferencesSpec, SessionFastPreferences } from '../preferences.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function open(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.effect(() => () => facility.closeAll())
  const domain = await facility.open(preferencesSpec)
  return { pool, domain, preferences: new SessionFastPreferences(domain.table('sessions')) }
}

describe('session Fast preferences', () => {
  it('defaults to disabled without writing and isolates sessions', async () => {
    const { domain, preferences } = await open()
    expect(preferences.get('session-a')).toEqual({ enabled: false, serviceTier: 'default' })
    expect(domain.table('sessions').size).toBe(0)
    await preferences.set('session-a', true)
    expect(preferences.get('session-a')).toEqual({ enabled: true, serviceTier: 'fast' })
    expect(preferences.get('session-b')).toEqual({ enabled: false, serviceTier: 'default' })
  })

  it('reopens committed on and off records instead of applying the default again', async () => {
    const first = await open()
    await first.preferences.set('off-session', false)
    await first.preferences.set('on-session', true)
    await first.domain.close()
    const reopened = await open(first.pool)
    expect(reopened.preferences.get('off-session')).toEqual({ enabled: false, serviceTier: 'default' })
    expect(reopened.preferences.get('on-session')).toEqual({ enabled: true, serviceTier: 'fast' })
  })

  it('keeps committed state and medium unchanged after a failed write', async () => {
    const { pool, domain, preferences } = await open()
    await preferences.set('session', true)
    pool.failNextWrites = 1
    await expect(preferences.set('session', false)).rejects.toThrow('injected write failure')
    expect(preferences.get('session')).toEqual({ enabled: true, serviceTier: 'fast' })
    await domain.close()
    const reopened = await open(pool)
    expect(reopened.preferences.get('session')).toEqual({ enabled: true, serviceTier: 'fast' })
  })

  it('publishes no optimistic setting before backend durability', async () => {
    const records = new Map<string, { enabled: boolean }>()
    let commit: (() => void) | undefined
    const preferences = new SessionFastPreferences({
      get: (id: string) => records.get(id),
      put: (id: string, value: { enabled: boolean }) => new Promise<void>((resolve) => {
        commit = () => { records.set(id, value); resolve() }
      }),
    })
    const pending = preferences.set('session', true)
    expect(preferences.get('session')).toEqual({ enabled: false, serviceTier: 'default' })
    expect(commit).toBeTypeOf('function')
    commit!()
    await expect(pending).resolves.toEqual({ enabled: true, serviceTier: 'fast' })
  })

  it('rejects malformed stored preference records on open', async () => {
    const first = await open()
    await first.domain.close()
    first.pool.media.get('codex_session_fast')!.tables.set('sessions', new Map([
      ['session', { enabled: 'yes' }],
    ]))
    await expect(open(first.pool)).rejects.toMatchObject({ code: 'invalid-record' })
  })
})
