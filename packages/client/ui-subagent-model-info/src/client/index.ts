/** Subagent model and reasoning effort display plugin for Web client. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { SubagentModelBadge } from './SubagentModelBadge.tsx'
import { SubagentToolView } from './SubagentToolView.tsx'
import { en, NS, zh, type SubagentModelInfoKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent model info translation dictionary. */
    'subagent-model-info': SubagentModelInfoKey
  }
}

/** Required services for dictionary registration and slot contribution. */
export const inject = ['slots', 'locale']

/**
 * Register subagent model information into tool views and header lineage.
 * @param ctx - Client context owning slots and locale services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-model-info: dictionaries')

  ctx.slots.inject('subagent.lineage.item.meta', () => ctx.slots.register({
    name: 'subagent.lineage.item.meta',
    locale: NS,
  }, SubagentModelBadge))
  ctx.slots.inject('conversation.session.header.actions.subagent.item.meta', () => ctx.slots.register({
    name: 'conversation.session.header.actions.subagent.item.meta',
    locale: NS,
  }, SubagentModelBadge))

  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'subagent',
      priority: -10,
      locale: NS,
    }, SubagentToolView)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'subagent_fork',
      priority: -10,
      locale: NS,
    }, SubagentToolView)
  })
}
