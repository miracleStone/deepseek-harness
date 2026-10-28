/** Refresh the existing llm-pi-ai subscription grant without ambient credential discovery. */
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { CodexError } from './http.js'

const PROVIDER = 'openai-codex'
const KEY = credentialKey('llm-pi-ai', PROVIDER)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0
const headerValue = value => nonEmpty(value) && !/[\u0000-\u0020\u007f-\uffff]/u.test(value)

/** Validate persisted JSON before passing it to pi-ai; absence alone means unsigned-in. */
function grant(record) {
  if (record === undefined) return undefined
  const value = record.payload
  if (record.kind !== 'grant' || value === null || typeof value !== 'object' || Array.isArray(value)
    || value.type !== 'oauth' || !headerValue(value.access) || !nonEmpty(value.refresh)
    || typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires < 0
    || !headerValue(value.accountId)) {
    throw new CodexError('Codex subscription grant is invalid; sign in again', 'CODEX_AUTH_INVALID')
  }
  // pi-ai can receive frozen snapshots; never give it the service's retained object.
  return structuredClone(value)
}

/**
 * Create an account-consistent auth resolver. Refresh runs inside the credential service's atomic modification.
 * No environment, auth files, or copied grants are consulted. ready() reads storage without refreshing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context carrying the credentials service.
 * @returns {((signal?:AbortSignal)=>Promise<{access:string,accountId:string}>) & {ready:()=>Promise<boolean>}} Resolver with a local readiness check.
 */
export function createSubscriptionAuth(ctx) {
  const service = () => ctx.get('credentials')
  const checkAbort = signal => {
    if (signal?.aborted) throw new CodexError('Codex authentication aborted', 'CODEX_ABORTED')
  }
  const store = {
    async read(provider, options) {
      checkAbort(options?.signal)
      if (provider !== PROVIDER) return undefined
      const value = grant(await service()?.readRecord(KEY))
      checkAbort(options?.signal)
      return value
    },
    async list() {
      return await store.read(PROVIDER) === undefined ? [] : [{ providerId: PROVIDER, type: 'oauth' }]
    },
    async modify(provider, mutate, options) {
      checkAbort(options?.signal)
      if (provider !== PROVIDER || service() === undefined) {
        throw new CodexError('Codex subscription is not signed in', 'CODEX_AUTH_MISSING')
      }
      const result = await service().modifyRecord(KEY, async current => {
        checkAbort(options?.signal)
        const next = await mutate(grant(current))
        checkAbort(options?.signal)
        return next === undefined ? undefined : { kind: 'grant', payload: grant({ kind: 'grant', payload: next }) }
      })
      return grant(result)
    },
    async delete() {
      throw new CodexError('Codex capability authentication cannot delete credentials', 'CODEX_AUTH_FAILED')
    },
  }
  const models = builtinModels({
    credentials: store,
    authContext: { async env() { return undefined }, async fileExists() { return false } },
  })
  const getAuth = async signal => {
    try {
      checkAbort(signal)
      // Account switches can occur between refresh and read; never combine two grants.
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = await models.getAuth(PROVIDER, { signal })
        checkAbort(signal)
        const current = await store.read(PROVIDER, { signal })
        checkAbort(signal)
        if (current === undefined || !headerValue(resolved?.auth.apiKey)) break
        if (resolved.auth.apiKey === current.access) return { access: current.access, accountId: current.accountId }
      }
      throw new CodexError('Codex subscription is not signed in or changed accounts; sign in again', 'CODEX_AUTH_MISSING')
    } catch (error) {
      checkAbort(signal)
      if (error instanceof CodexError) throw error
      // pi-ai errors can retain token-bearing server diagnostics in their cause.
      throw new CodexError('Codex subscription authentication failed; sign in again', 'CODEX_AUTH_FAILED')
    }
  }
  getAuth.ready = async () => {
    try { return await store.read(PROVIDER) !== undefined }
    catch (error) {
      if (error instanceof CodexError) throw error
      throw new CodexError('Codex subscription credential storage is unavailable', 'CODEX_AUTH_FAILED')
    }
  }
  return getAuth
}
