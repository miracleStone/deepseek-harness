/** Credential-bearing Codex JSON transport. Errors never retain response bodies or upstream errors. */

/** Structured, sanitized failure from subscription authentication or a Codex request. */
export class CodexError extends Error {
  /**
   * @param {string} message - Safe diagnostic text owned by this bundle.
   * @param {string} code - Stable machine-readable failure identity.
   * @param {number} [status] - HTTP status, when a response was received.
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'CodexError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/**
 * Send one POST without redirects or retries; bound the complete response before JSON parsing.
 * Cancellation and timeout cover headers and body consumption. Failed requests may have reached the server.
 * @param {string} path - Relative Codex endpoint, appended to baseURL.
 * @param {unknown} body - JSON request value.
 * @param {{access:string, accountId:string}} auth - One account's credential snapshot.
 * @param {AbortSignal | undefined} signal - Caller cancellation; omitted means timeout only.
 * @param {{baseURL:string, timeoutMs:number, maxResponseBytes:number, turnId?:string}} options - Explicit transport limits.
 * @returns {Promise<unknown>} Parsed response JSON; rejects with sanitized CodexError.
 */
export async function requestJson(path, body, auth, signal, options) {
  if (signal?.aborted) throw new CodexError('Codex request aborted', 'CODEX_ABORTED')
  const controller = new AbortController()
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let status
  try {
    const response = await fetch(`${options.baseURL.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`, {
      method: 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        authorization: `Bearer ${auth.access}`,
        'chatgpt-account-id': auth.accountId,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options.turnId === undefined ? {} : { 'x-codex-image-turn-id': options.turnId }),
        originator: 'pi',
        'user-agent': 'dsh-codex-capabilities',
      },
      body: JSON.stringify(body),
    })
    status = response.status
    if (!response.ok) {
      // Error bodies are untrusted and can echo credentials; never decode or retain them.
      await response.body?.cancel()
      throw new CodexError(
        status === 401 ? 'Codex subscription access denied; sign in again'
          : status === 403 ? 'Codex access denied; check subscription plan, workspace, region, and network restrictions'
            : status === 429 ? 'Codex quota or rate limit reached; try again later' : `Codex request failed (HTTP ${status})`,
        status === 401 ? 'CODEX_AUTH_FAILED' : status === 403 ? 'CODEX_ACCESS_DENIED' : 'CODEX_HTTP_ERROR', status,
      )
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new CodexError('Codex returned an empty response', 'CODEX_INVALID_RESPONSE', status)
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > options.maxResponseBytes) {
          await reader.cancel()
          throw new CodexError('Codex response exceeds the configured byte limit', 'CODEX_RESPONSE_TOO_LARGE', status)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    combined.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      // Parsing errors may quote response text and must not escape this transport.
      throw new CodexError('Codex returned invalid JSON', 'CODEX_INVALID_RESPONSE', status)
    }
  } catch (error) {
    if (signal?.aborted) throw new CodexError('Codex request aborted; outcome is unknown and quota may have been consumed; no retry was attempted', 'CODEX_ABORTED', status)
    if (controller.signal.aborted) throw new CodexError('Codex request timed out; outcome is unknown and quota may have been consumed; no retry was attempted', 'CODEX_TIMEOUT', status)
    if (error instanceof CodexError) throw error
    throw new CodexError('Codex request failed; outcome is unknown and quota may have been consumed; no retry was attempted', 'CODEX_NETWORK_ERROR', status)
  } finally {
    clearTimeout(timer)
  }
}
