/** Custom Tool view for subagent and subagent_fork calls showing model and reasoning effort. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DisclosureRow, IconAgentPresetOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import css from './SubagentToolView.module.css'

export type SubagentToolViewProps = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS>

function singleResultText(block: ToolCallBlock): string | undefined {
  if (!('kind' in block) || block.content.length !== 1) return undefined
  const item = block.content[0]
  return item?.type === 'text' ? item.text : undefined
}

type DelegationReceipt =
  | { kind: 'activation'; name?: string; id?: string }
  | { kind: 'background-job'; id: string }

/** Current metadata names agents; only metadata-free historical receipts may contain Session IDs. */
function receiptOf(block: ToolCallBlock, text: string | undefined): DelegationReceipt | undefined {
  if (!('kind' in block) || block.isError) return undefined
  const { meta } = block
  if (meta !== undefined) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)
      || !('kind' in meta) || meta.kind !== 'activation') return undefined
    const name = 'name' in meta ? meta.name : undefined
    const id = 'subagentId' in meta ? meta.subagentId : undefined
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) return undefined
    if (id !== undefined && (typeof id !== 'string' || id.trim() === '')) return undefined
    if (name === undefined && id === undefined) return undefined
    return {
      kind: 'activation',
      ...typeof name === 'string' ? { name } : {},
      ...typeof id === 'string' ? { id } : {},
    }
  }
  const started = text === undefined ? null : /^started (background subagent job|subagent) (\S+)$/u.exec(text)
  const id = started?.[2]
  if (id === undefined) return undefined
  return started?.[1] === 'background subagent job'
    ? { kind: 'background-job', id }
    : { kind: 'activation', id }
}

/**
 * Render a subagent delegation tool call with model and reasoning effort.
 * @param props - Tool call owner props plus translator.
 * @returns An expandable disclosure row with subagent details.
 */
export function SubagentToolView({
  block, sessionId, useDisclosure, useSessions, t,
}: SubagentToolViewProps) {
  const { expanded, toggle } = useDisclosure()
  const args = block.args
  const text = singleResultText(block)

  const receipt = receiptOf(block, text)
  const subagentId = useSessions(state => {
    if (receipt?.kind !== 'activation') return undefined
    const catalog = state.projectionsBySession[sessionId]?.values.subagentCatalog
      ?? state.byId[sessionId]?.projectionValues?.subagentCatalog
    if (receipt.name !== undefined) {
      const entry = catalog?.find(entry => entry.mode === 'continuable' && entry.name === receipt.name)
      return entry !== undefined && (receipt.id === undefined || entry.id === receipt.id) ? entry.id : undefined
    }
    // A legacy ID must already identify this parent's local child; job IDs and names never enter byId lookups.
    const entry = catalog?.find(entry => entry.mode !== 'external' && entry.id === receipt.id)
    if (entry !== undefined) return entry.id
    if (catalog !== undefined) return undefined
    return Object.values(state.byId).find(child => child.id === receipt.id
      && child.parentId === sessionId && child.origin === 'subagent')?.id
  })

  const summary = useSessions(state => subagentId ? state.byId[subagentId] : undefined)
  const projection = useSessions(state => subagentId ? state.projectionsBySession[subagentId] : undefined)

  const argModel = args.text('model') || undefined
  const argEffort = args.text('reasoning_effort') || undefined

  const modelSelection = summary?.projectionValues?.modelSelection ?? projection?.values?.modelSelection
  const subagentMeta = summary?.projectionValues?.subagent ?? projection?.values?.subagent

  const selection = modelSelection?.lastUsed ?? modelSelection?.next
  const descriptor = subagentMeta?.mode === 'continuable' ? subagentMeta : undefined
  const model = argModel ?? selection?.model ?? descriptor?.model
  const effort = argEffort ?? (selection == null ? descriptor?.reasoningEffort : selection.reasoningEffort)

  const isRunning = !('kind' in block)
  const isError = 'kind' in block && block.isError

  const description = args.text('description') || undefined
  const prompt = args.text('prompt')
  const title = description || prompt || t('title.subagent')
  const statusLabel = isRunning ? '' : isError ? t('status.error') : t('status.started')
  const modelText = model ? (effort ? `${model} (${effort})` : model) : (effort ? `(${effort})` : undefined)
  const summaryText = [title, statusLabel, modelText].filter(Boolean).join(' · ')

  return (
    <div data-subagent-toolview="">
      <DisclosureRow
        icon={<IconAgentPresetOutlineRegular size={14} />}
        title={t('title.subagent')}
        open={expanded}
        expandable={true}
        onToggle={toggle}
        running={isRunning}
        collapsedContent={<span>{summaryText}</span>}
      >
        <div className={css.expandedCard}>
          <div className={css.fieldGrid}>
            {receipt?.kind === 'activation' && receipt.name !== undefined && (
              <>
                <span className={css.fieldLabel}>{t('field.name')}:</span>
                <span className={css.fieldValue}>{receipt.name}</span>
              </>
            )}
            {receipt !== undefined && (subagentId ?? receipt.id) !== undefined && (
              <>
                <span className={css.fieldLabel}>{t(receipt.kind === 'background-job' ? 'field.job' : 'field.agent')}:</span>
                <span className={css.fieldValue}>{subagentId ?? receipt.id}</span>
              </>
            )}
            {model && (
              <>
                <span className={css.fieldLabel}>{t('field.model')}:</span>
                <span className={css.fieldValue}>{model}</span>
              </>
            )}
            {effort && (
              <>
                <span className={css.fieldLabel}>{t('field.reasoningEffort')}:</span>
                <span className={css.fieldValue}>{effort}</span>
              </>
            )}
          </div>
          {prompt && (
            <div className={css.taskSection}>
              <div className={css.fieldLabel}>{t('field.task')}:</div>
              <div className={css.taskText}>{prompt}</div>
            </div>
          )}
          {text && receipt === undefined && (
            <div className={css.outputSection}>
              <div className={css.fieldLabel}>{t('status.reply')}:</div>
              <div className={css.taskText}>{text}</div>
            </div>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
