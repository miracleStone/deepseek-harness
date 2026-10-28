/** Native Codex alpha/search provider; deployment defaults belong to the bundle config. */
import { randomUUID } from 'node:crypto'
import { WebError } from '@deepseek-ai/dsh-web'
import { CodexError, requestJson } from './http.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() || undefined : undefined

/** Normalize only HTTP(S) sources; malformed individual results do not invalidate their peers. */
function sourceOf(value) {
  if (!object(value) || typeof value.url !== 'string') return undefined
  let url
  try { url = new URL(value.url) }
  catch (error) { return undefined /* An unparseable source cannot be cited. */ }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
  const snippet = text(value.snippet)
  const publishedAt = text(value.published_at) ?? text(value.publishedAt)
  return {
    url: url.href,
    title: text(value.title) ?? url.hostname,
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt: publishedAt.slice(0, 64) }),
  }
}

/**
 * Create the subscription-only search provider. No API-key fallback or automatic retry is performed.
 * @param {{getAuth:((signal?:AbortSignal)=>Promise<{access:string,accountId:string}>) & {ready?:()=>Promise<boolean>},baseURL:string,timeoutMs:number,maxResponseBytes:number,model:string,mode:'live'|'cached',maxOutputTokens:number}} options - Validated, explicit config and auth resolver.
 * @returns {import('@deepseek-ai/dsh-web').WebSearchProvider} Provider enforcing maxResults after URL normalization and deduplication.
 */
export function createSearchProvider(options) {
  return Object.freeze({
    id: 'codex-subscription',
    available: () => true,
    ready: () => options.getAuth.ready === undefined ? Promise.resolve(true) : options.getAuth.ready(),
    async search(request, signal) {
      try {
        if (signal?.aborted) throw new CodexError('Codex search aborted', 'CODEX_ABORTED')
        const auth = await options.getAuth(signal)
        const value = await requestJson('alpha/search', {
          id: randomUUID(),
          model: options.model,
          input: request.query,
          commands: { search_query: [{ q: request.query }], response_length: 'short' },
          settings: { allowed_callers: ['direct'], external_web_access: options.mode === 'live' },
          max_output_tokens: options.maxOutputTokens,
        }, auth, signal, options)
        if (!object(value) || !Array.isArray(value.results)) {
          throw new CodexError('Codex returned a malformed search response', 'CODEX_INVALID_RESPONSE')
        }
        const seen = new Set()
        const sources = []
        for (const result of value.results) {
          const source = sourceOf(result)
          if (source === undefined || seen.has(source.url)) continue
          seen.add(source.url)
          sources.push(source)
        }
        const maximum = request.maxResults ?? sources.length
        return { sources: sources.slice(0, maximum), truncated: sources.length > maximum }
      } catch (error) {
        if (!(error instanceof CodexError)) throw error
        const code = error.code === 'CODEX_ABORTED' ? 'WEB_ABORTED'
          : ['CODEX_AUTH_MISSING', 'CODEX_AUTH_INVALID', 'CODEX_AUTH_FAILED'].includes(error.code)
            ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR'
        throw new WebError(error.message, code, { cause: error })
      }
    },
  })
}
