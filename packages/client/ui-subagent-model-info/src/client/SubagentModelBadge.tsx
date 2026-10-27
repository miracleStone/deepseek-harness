/** Badge showing model name and reasoning effort for one subagent lineage row. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import css from './SubagentModelBadge.module.css'

export type SubagentModelBadgeProps = PropsRuntime<'subagent.lineage.item.meta'>
  | PropsRuntime<'conversation.session.header.actions.subagent.item.meta'>

/**
 * Display model and reasoning-effort facts for one catalog row.
 * @param props - Slot runtime props providing the child session ID and standard hooks.
 * @returns Formatted label element or null when no model information is available.
 */
export function SubagentModelBadge({ childSessionId, useSessions }: SubagentModelBadgeProps) {
  const summary = useSessions(state => state.byId[childSessionId])
  const projection = useSessions(state => state.projectionsBySession[childSessionId])
  const modelSelection = summary?.projectionValues?.modelSelection ?? projection?.values?.modelSelection
  const subagentMeta = summary?.projectionValues?.subagent ?? projection?.values?.subagent

  const selection = modelSelection?.lastUsed ?? modelSelection?.next
  const descriptor = subagentMeta?.mode === 'continuable' ? subagentMeta : undefined
  const model = selection?.model ?? descriptor?.model
  const effort = selection == null ? descriptor?.reasoningEffort : selection.reasoningEffort

  if (model === undefined && effort === undefined) return null

  const text = model !== undefined
    ? (effort !== undefined ? `${model} (${effort})` : model)
    : `(${effort})`

  return (
    <span className={css.badge} data-subagent-model-info="">
      {text}
    </span>
  )
}
