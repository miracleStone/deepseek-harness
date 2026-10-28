/** Host-only Codex subscription capabilities; the existing conversation adapter keeps ownership of login. */
import z from '@deepseek-ai/schemastery'
import { createSubscriptionAuth } from './auth.js'
import { createSearchProvider } from './search.js'
import { createImageTool, resolveImageOptions } from './images.js'

export const name = 'codex-capabilities'
export const inject = ['credentials', 'web', 'tools', 'attachments']

/** Deployment controls; private endpoint availability remains account-dependent. */
export const Config = z.object({
  baseURL: z.string().default('https://chatgpt.com/backend-api/codex/'),
  searchModel: z.string().default('gpt-5.6-luna'),
  searchMode: z.union(['live', 'cached', 'disabled']).default('live'),
  searchTimeoutMs: z.number().step(1).min(1).max(2147483647).default(30000),
  searchMaxResponseBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  searchMaxOutputTokens: z.number().step(1).min(1).default(4096),
  imagesEnabled: z.boolean().default(true),
  imageModel: z.union(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']).default('gpt-image-2.5-flare'),
  imageQuality: z.union(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('auto'),
  imageTimeoutMs: z.number().step(1).min(1).max(2147483647).default(300000),
  maxImageBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
  imageEnvelopeBytes: z.number().step(1).min(1).default(1024 * 1024),
})

/** Register reversible contributions without changing model settings or copying credentials. */
export function apply(ctx, config) {
  const base = new URL(config.baseURL)
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))
    || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new Error('Codex baseURL must be HTTPS (or loopback HTTP for tests), contain no credentials, query, or fragment, and end with /.')
  }
  if (!config.searchModel.trim()) throw new Error('searchModel must be a non-empty model identifier.')
  resolveImageOptions({ prompt: 'validate configuration' }, config)
  const getAuth = createSubscriptionAuth(ctx)
  if (config.searchMode !== 'disabled') {
    ctx.web.registerSearchProvider(createSearchProvider({
      getAuth,
      baseURL: config.baseURL,
      timeoutMs: config.searchTimeoutMs,
      maxResponseBytes: config.searchMaxResponseBytes,
      model: config.searchModel,
      mode: config.searchMode,
      maxOutputTokens: config.searchMaxOutputTokens,
    }))
  }
  if (config.imagesEnabled) {
    ctx.tools.register(createImageTool({ attachments: ctx.attachments, getAuth, config }))
  }
}
