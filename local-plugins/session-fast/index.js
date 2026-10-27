/** User-only per-session Codex Fast controls; no model tools are registered. */
import * as adapter from './adapter.js'
import { preferencesSpec, SessionFastPreferences } from './preferences.js'
import { registerFastApi } from './api.js'

export const name = 'session-fast'
export const inject = ['llm', 'storageDomain', 'commands', 'connection']
export const Config = adapter.Config

/** Open durable preferences before exposing user controls and the Codex tier override. */
export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(preferencesSpec)
  ctx.effect(() => () => domain.close())
  const providers = config.providers.get()
  const preferences = new SessionFastPreferences(domain.table('sessions'), providers['openai-codex']?.serviceTier === 'fast')

  ctx.effect(() => registerFastApi(ctx, preferences))

  ctx.on('llm-pi-ai/service-tier', (request, next) => {
    if (request.provider !== 'openai-codex' || request.sessionId === undefined) return next()
    return preferences.get(request.sessionId).serviceTier
  })

  const saveFailure = (error) => {
    ctx.logger.warn('Session Fast setting was not saved', error)
    return 'Fast 设置未保存，请重试 / Fast setting was not saved; retry.'
  }

  ctx.effect(() => ctx.commands.register({
    name: 'fast',
    description: '查看或设置本会话 Fast / Read or set this session’s Fast processing',
    input: { hint: 'status | on | off' },
    recordInput: false,
    handler: async ({ agent, rawInput, signal }) => {
      signal.throwIfAborted()
      const action = rawInput.trim().toLowerCase() || 'status'
      if (!['status', 'on', 'off'].includes(action)) {
        return { kind: 'error', text: '用法 / Usage: /fast status | on | off' }
      }
      try {
        const state = action === 'status'
          ? preferences.get(agent.id)
          : await preferences.set(agent.id, action === 'on')
        return { kind: 'success', text: JSON.stringify({ enabled: state.enabled }) }
      } catch (error) {
        return { kind: 'error', text: saveFailure(error) }
      }
    },
  }))

  await adapter.apply(ctx, config)
}
