/** Keyless coverage of shared OAuth refresh, bounded transport, and native subscription search. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createSubscriptionAuth } from '../auth.js'
import { CodexError, requestJson } from '../http.js'
import { createSearchProvider } from '../search.js'

const transport = { baseURL: 'https://codex.example/backend-api/codex', timeoutMs: 10_000, maxResponseBytes: 4096 }
const auth = { access: 'private-access', accountId: 'account-a' }
const stored = (overrides = {}) => Object.freeze({ kind: 'grant' as const, payload: Object.freeze({
  type: 'oauth', access: auth.access, refresh: 'private-refresh', accountId: auth.accountId,
  expires: Date.now() + 3_600_000, ...overrides,
}) })

function credentials(initial: CredentialRecord | undefined = stored()) {
  let record = initial
  let chain = Promise.resolve()
  const readRecord = vi.fn(async () => record)
  const modifyRecord = vi.fn((_key, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
    const result = chain.then(async () => { record = await mutate(record) ?? record; return record })
    chain = result.then(() => undefined, () => undefined)
    return result
  })
  const ctx = { get: vi.fn(() => ({ readRecord, modifyRecord })) } as Context
  return { getAuth: createSubscriptionAuth(ctx), readRecord, modifyRecord, record: () => record }
}

function mockFetch(value: unknown = { results: [] }, status = 200) {
  const stub = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(value), { status }))
  vi.stubGlobal('fetch', stub)
  return stub
}

function searchOptions(getAuth = Object.assign(vi.fn(async () => auth), { ready: vi.fn(async () => true) })) {
  return { ...transport, getAuth, model: 'gpt-5.6-luna', mode: 'live' as const, maxOutputTokens: 4096 }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('subscription authentication', () => {
  it('reads only the existing scoped grant, including frozen storage snapshots', async () => {
    const fetch = mockFetch()
    const fixture = credentials()
    expect(await fixture.getAuth.ready()).toBe(true)
    expect(await fixture.getAuth()).toEqual(auth)
    expect(fixture.readRecord).toHaveBeenCalledWith('llm-pi-ai/openai-codex')
    expect(fetch).not.toHaveBeenCalled()
    const current = fixture.record()
    expect(current?.kind).toBe('grant')
    expect(Object.isFrozen(current?.kind === 'grant' ? current.payload : undefined)).toBe(true)
  })

  it('reports missing credentials without environment or file discovery', async () => {
    const fetch = mockFetch()
    const getAuth = createSubscriptionAuth({ get: () => undefined } as Context)
    expect(await getAuth.ready()).toBe(false)
    await expect(getAuth()).rejects.toMatchObject({ code: 'CODEX_AUTH_MISSING' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'api-key', key: 'private-key' },
    { kind: 'grant', payload: null },
    { kind: 'grant', payload: [] },
    stored({ type: 'api_key' }), stored({ access: '' }), stored({ access: 'bad\r\ntoken' }),
    stored({ refresh: '' }), stored({ expires: 'tomorrow' }), stored({ expires: Infinity }),
    stored({ accountId: 'bad\naccount' }),
  ])('rejects malformed persisted grants without leaking their payload (%#)', async record => {
    const fetch = mockFetch()
    const fixture = credentials(record as CredentialRecord)
    await expect(fixture.getAuth.ready()).rejects.toMatchObject({ code: 'CODEX_AUTH_INVALID' })
    const error = await fixture.getAuth().catch(error => error)
    expect(error).toBeInstanceOf(CodexError)
    expect(JSON.stringify(error)).not.toMatch(/private-key|private-access|private-refresh/u)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses pi-ai refresh and commits one rotated grant under atomic store exclusion', async () => {
    const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-b' } })).toString('base64url')}.signature`
    const fetch = mockFetch({ access_token: access, refresh_token: 'rotated-refresh', expires_in: 3600 })
    const fixture = credentials(stored({ expires: 0 }))
    expect(await fixture.getAuth.ready()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    const resolved = await Promise.all([fixture.getAuth(), fixture.getAuth()])
    expect(resolved).toEqual([{ access, accountId: 'account-b' }, { access, accountId: 'account-b' }])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('auth.openai.com')
    expect(fixture.modifyRecord).toHaveBeenCalled()
    expect(fixture.record()).toMatchObject({ kind: 'grant', payload: { access, refresh: 'rotated-refresh', accountId: 'account-b' } })
  })

  it('re-resolves an account switch instead of pairing one account token with another account id', async () => {
    const fetch = mockFetch()
    const fixture = credentials()
    const next = stored({ access: 'second-access', accountId: 'account-b' })
    fixture.readRecord.mockResolvedValueOnce(stored()).mockResolvedValue(next)
    expect(await fixture.getAuth()).toEqual({ access: 'second-access', accountId: 'account-b' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops after bounded attempts when accounts keep changing', async () => {
    const fixture = credentials()
    const next = stored({ access: 'second-access', accountId: 'account-b' })
    fixture.readRecord.mockResolvedValueOnce(stored()).mockResolvedValueOnce(next)
      .mockResolvedValueOnce(stored()).mockResolvedValueOnce(next)
    await expect(fixture.getAuth()).rejects.toMatchObject({ code: 'CODEX_AUTH_MISSING' })
    expect(fixture.readRecord).toHaveBeenCalledTimes(4)
  })

  it('preserves the old grant and sanitizes failed refresh diagnostics', async () => {
    mockFetch({ error: 'private-access private-refresh' }, 401)
    const initial = stored({ expires: 0 })
    const fixture = credentials(initial)
    const error = await fixture.getAuth().catch(error => error)
    expect(error).toMatchObject({ code: 'CODEX_AUTH_FAILED' })
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain('private-')
    expect(fixture.record()).toBe(initial)
  })

  it('honors cancellation before reading or refreshing', async () => {
    const fixture = credentials()
    await expect(fixture.getAuth(AbortSignal.abort('private reason'))).rejects.toMatchObject({ code: 'CODEX_ABORTED' })
    expect(fixture.readRecord).not.toHaveBeenCalled()
  })
})

describe('Codex JSON transport', () => {
  it('sets subscription headers and appends paths without changing the configured prefix', async () => {
    const fetch = mockFetch({ ok: true })
    expect(await requestJson('/alpha/search', { query: 'x' }, auth, undefined, { ...transport, turnId: 'call-id' })).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith(`${transport.baseURL}/alpha/search`, expect.objectContaining({
      redirect: 'error', method: 'POST', headers: expect.objectContaining({
        authorization: 'Bearer private-access', 'chatgpt-account-id': 'account-a',
        originator: 'pi', 'user-agent': 'dsh-codex-capabilities', 'x-codex-image-turn-id': 'call-id',
      }),
    }))
  })

  it('does not contact a redirect target', async () => {
    let targets = 0
    const server = createServer((request, response) => {
      if (request.url === '/target') { targets++; response.end('{}'); return }
      response.writeHead(302, { location: '/target' }); response.end()
    })
    server.listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing test server address')
      await expect(requestJson('redirect', {}, auth, undefined, { ...transport, baseURL: `http://127.0.0.1:${address.port}` }))
        .rejects.toMatchObject({ code: 'CODEX_NETWORK_ERROR' })
      expect(targets).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each([401, 403, 429, 500])('sanitizes HTTP %i and never retries', async status => {
    const fetch = mockFetch({ error: 'private-access private-refresh' }, status)
    const error = await requestJson('images', {}, auth, undefined, transport).catch(error => error)
    expect(error).toMatchObject({ status, code: status === 401 ? 'CODEX_AUTH_FAILED' : status === 403 ? 'CODEX_ACCESS_DENIED' : 'CODEX_HTTP_ERROR' })
    expect(String(error)).not.toContain('private-')
    expect(error.cause).toBeUndefined()
    if (status === 403) { expect(error.message).not.toContain('sign in'); expect(error.message).toContain('workspace') }
    if (status === 429) expect(error.message).toContain('try again later')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds UTF-8 bytes, accepting the exact limit and cancelling oversized streams', async () => {
    const bytes = new TextEncoder().encode('"é"')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
    expect(await requestJson('search', {}, auth, undefined, { ...transport, maxResponseBytes: bytes.length })).toBe('é')
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes) }, cancel }))))
    await expect(requestJson('search', {}, auth, undefined, { ...transport, maxResponseBytes: bytes.length - 1 }))
      .rejects.toMatchObject({ code: 'CODEX_RESPONSE_TOO_LARGE', status: 200 })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid JSON without quoting response text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-access invalid json')))
    const error = await requestJson('search', {}, auth, undefined, transport).catch(error => error)
    expect(error).toMatchObject({ code: 'CODEX_INVALID_RESPONSE', status: 200 })
    expect(String(error)).not.toContain('private-')
    expect(error.cause).toBeUndefined()
  })

  it('cancels body consumption and distinguishes caller abort from timeout', async () => {
    vi.useFakeTimers()
    let reading!: () => void
    const started = new Promise<void>(resolve => { reading = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error('private-access'))) },
      pull() { reading() },
    }))))
    const timeout = requestJson('search', {}, auth, undefined, { ...transport, timeoutMs: 100 })
    const checkedTimeout = expect(timeout).rejects.toMatchObject({ code: 'CODEX_TIMEOUT' })
    await started
    await vi.advanceTimersByTimeAsync(100)
    await checkedTimeout
    const controller = new AbortController()
    const cancelled = requestJson('search', {}, auth, controller.signal, transport)
    const checkedAbort = expect(cancelled).rejects.toMatchObject({ code: 'CODEX_ABORTED', message: expect.stringContaining('outcome is unknown') })
    controller.abort('private-refresh')
    await checkedAbort
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('native subscription search', () => {
  it('sends the alpha/search protocol and preserves configured model and cached mode', async () => {
    const fetch = mockFetch()
    const options = { ...searchOptions(), mode: 'cached' as const, maxOutputTokens: 777 }
    const provider = createSearchProvider(options)
    expect(provider.id).toBe('codex-subscription')
    expect(provider.available()).toBe(true)
    expect(await provider.ready?.(undefined)).toBe(true)
    expect(await provider.search({ query: 'native query' })).toEqual({ sources: [], truncated: false })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${transport.baseURL}/alpha/search`)
    expect(JSON.parse(init.body)).toEqual({
      id: expect.any(String), model: 'gpt-5.6-luna', input: 'native query',
      commands: { search_query: [{ q: 'native query' }], response_length: 'short' },
      settings: { allowed_callers: ['direct'], external_web_access: false }, max_output_tokens: 777,
    })
  })

  it('normalizes HTTP(S) sources, deduplicates normalized URLs, and enforces maxResults', async () => {
    mockFetch({ results: [
      null, { url: 'javascript:alert(1)' }, { url: 'file:///private' }, { url: 'not a URL' },
      { url: 'https://user:password@example.com' },
      { url: 'https://EXAMPLE.com', title: ' Example  title ', snippet: 'text\nexcerpt', published_at: '2026-10-27' },
      { url: 'https://example.com/', title: 'duplicate' }, { url: 'http://second.example/path' }, { url: 'https://third.example/' },
    ] })
    const provider = createSearchProvider(searchOptions())
    expect(await provider.search({ query: 'x', maxResults: 2 })).toEqual({ sources: [
      { url: 'https://example.com/', title: 'Example title', snippet: 'text excerpt', publishedAt: '2026-10-27' },
      { url: 'http://second.example/path', title: 'second.example' },
    ], truncated: true })
    expect((await provider.search({ query: 'x', maxResults: 0 })).sources).toEqual([])
    expect((await provider.search({ query: 'x' })).truncated).toBe(false)
  })

  it('maps auth, cancellation, and malformed response failures to the web capability codes', async () => {
    const fetch = mockFetch({ wrong: [] })
    const provider = createSearchProvider(searchOptions())
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause: { code: 'CODEX_INVALID_RESPONSE' } })
    await expect(provider.search({ query: 'x' }, AbortSignal.abort())).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    const options = searchOptions(Object.assign(vi.fn(async () => { throw new CodexError('Sign in again', 'CODEX_AUTH_MISSING') }), { ready: vi.fn(async () => false) }))
    const unsigned = createSearchProvider(options)
    expect(await unsigned.ready?.(undefined)).toBe(false)
    await expect(unsigned.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
