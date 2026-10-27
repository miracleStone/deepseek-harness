// @vitest-environment jsdom
import { describe, expect, it, onTestFinished, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { allowAllAccess, contextMenuHook, makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { UseDisclosure } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PreparingToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as HostPlugin from '../src/index.ts'
import * as ModelInfoPlugin from '../src/client/index.ts'
import { SubagentModelBadge, type SubagentModelBadgeProps } from '../src/client/SubagentModelBadge.tsx'
import { SubagentToolView, type SubagentToolViewProps } from '../src/client/SubagentToolView.tsx'
import { zh } from '../src/client/locales.ts'

const LINEAGE_SLOT = 'subagent.lineage.item.meta'
const CATALOG_SLOT = 'conversation.session.header.actions.subagent.item.meta'
const TOOL_SLOT = 'tool.call.toolview'

const t: SubagentToolViewProps['t'] = makeTranslate(zh)

function mockDisclosure(initialExpanded = false): UseDisclosure {
  let expanded = initialExpanded
  return () => ({
    expanded,
    setExpanded: (open: boolean) => { expanded = open },
    toggle: () => { expanded = !expanded },
  })
}

async function testRuntime() {
  const host = await SlotTestRuntime.create()
  onTestFinished(() => host.dispose())
  const locale = new LocaleRuntime(host.ctx)
  host.ctx.provide('locale', locale)
  host.slots.installLocale(locale)
  await host.mount(HostPlugin)
  await host.declare({
    [LINEAGE_SLOT]: { kind: 'single', scope: 'session', inline: true },
    [CATALOG_SLOT]: { kind: 'single', scope: 'session', inline: true },
    [TOOL_SLOT]: { kind: 'keyed', scope: 'session' },
  })
  return host
}

afterEach(() => {
  cleanup()
})

function summary(id: SessionId, projectionValues: SessionSummary['projectionValues'] = {}): SessionSummary {
  return {
    id, displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 1,
    projectionValues,
  }
}

function standardProps(
  byId: SessionListState['byId'] = {},
  projectionsBySession: SessionListState['projectionsBySession'] = {},
): Omit<SubagentModelBadgeProps, 'childSessionId'> {
  const state: SessionListState = {
    ids: Object.values(byId).map(session => session.id),
    byId,
    phase: 'ready',
    projectionsBySession,
  }
  const unused = (): never => { throw new Error('Model info fixture does not provide this slot source or action') }
  return {
    sessionId: SessionId('parent'),
    useSessions: select => select(state),
    useSessionStatus: unused,
    useSessionRetainInfo: unused,
    usePanelInfo: unused,
    useWorkspaces: unused,
    useResource: unused,
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
    useSession: unused,
    useProjection: unused,
    useConversation: unused,
    useInput: unused,
    useChat: unused,
    useTrajectory: unused,
    inputActions: {
      insertQuote: () => false,
      captureInsertion: unused,
      insertText: unused,
      setDraft: unused,
      persistDraft: unused,
      addAttachments: unused,
      removeAttachment: unused,
      pruneAttachments: unused,
      submit: unused,
    },
  }
}

function toolProps(
  block: ToolResultNode, byId: SessionListState['byId'] = {}, expanded = false,
  projectionsBySession: SessionListState['projectionsBySession'] = {},
): SubagentToolViewProps {
  return {
    ...standardProps(byId, projectionsBySession),
    phase: 'result',
    callId: block.callId,
    toolName: block.name,
    openFile: () => {},
    loadImage: () => Promise.resolve(''),
    block,
    useDisclosure: mockDisclosure(expanded),
    t,
  }
}

function toolResult(callId: string, name: string, argsRaw: string, text: string): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 2,
    time: 2,
    callId,
    name,
    args: PartialArguments.fromText(argsRaw),
    call: { name, argsRaw },
    callTime: 1,
    content: [{ type: 'text', text }],
    isError: false,
    subCalls: [],
  }
}

describe('SubagentModelBadge', () => {
  it('renders model name and reasoning effort when both are present', () => {
    const childId = SessionId('child-1')
    const props: SubagentModelBadgeProps = {
      ...standardProps({
        [childId]: summary(childId, {
          modelSelection: {
            lastUsed: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: ReasoningEffortId('high') },
            next: null,
          },
        }),
      }),
      childSessionId: childId,
    }

    const { container } = render(<SubagentModelBadge {...props} />)
    expect(container.textContent).toContain('deepseek-chat (high)')
  })

  it('renders only model name when reasoning effort is absent', () => {
    const childId = SessionId('child-2')
    const props: SubagentModelBadgeProps = {
      ...standardProps({
        [childId]: summary(childId, {
          modelSelection: {
            lastUsed: { provider: 'deepseek-official', model: 'deepseek-chat' },
            next: null,
          },
        }),
      }),
      childSessionId: childId,
    }

    const { container } = render(<SubagentModelBadge {...props} />)
    expect(container.textContent).toContain('deepseek-chat')
    expect(container.textContent).not.toContain('(')
  })

  it('updates from the initial descriptor to a recorded model without borrowing the next selection effort', () => {
    const childId = SessionId('child-updating')
    const descriptor = {
      mode: 'continuable' as const, label: 'worker', seq: SessionSeq(1), model: 'initial-model', reasoningEffort: 'high',
    }
    const view = render(<SubagentModelBadge {...standardProps({
      [childId]: summary(childId, { subagent: descriptor }),
    })} childSessionId={childId} />)
    expect(view.container.textContent).toBe('initial-model (high)')
    view.rerender(<SubagentModelBadge {...standardProps({
      [childId]: summary(childId, {
        subagent: descriptor,
        modelSelection: {
          lastUsed: { provider: 'route', model: 'recorded-model' },
          next: { provider: 'next-route', model: 'next-model', reasoningEffort: ReasoningEffortId('max') },
        },
      }),
    })} childSessionId={childId} />)
    expect(view.container.textContent).toBe('recorded-model')
  })

  it('reads the next selection from the projection when the child is absent from the list', () => {
    const childId = SessionId('projection-only')
    const view = render(<SubagentModelBadge {...standardProps({}, {
      [childId]: { state: 'ready', error: null, values: { modelSelection: {
        lastUsed: null,
        next: { provider: 'route', model: 'next-model', reasoningEffort: ReasoningEffortId('low') },
      } } },
    })} childSessionId={childId} />)
    expect(view.container.textContent).toBe('next-model (low)')
  })

  it('renders null when no model or reasoning effort is available', () => {
    const childId = SessionId('child-3')
    const props: SubagentModelBadgeProps = {
      ...standardProps({ [childId]: summary(childId) }),
      childSessionId: childId,
    }

    const { container } = render(<SubagentModelBadge {...props} />)
    expect(container.textContent).toBe('')
  })
})

describe('SubagentToolView', () => {
  it('updates model and effort as the same preparing argument view grows', () => {
    const args = new PartialArguments()
    args.append('{"description":"Review parser"')
    const block: PreparingToolCall = {
      phase: 'preparing', callId: 'call-streaming', name: 'subagent',
      turn: 1, step: 1, time: 1, subCalls: [], args,
    }
    const props: SubagentToolViewProps = {
      ...standardProps(),
      phase: 'preparing',
      block,
      callId: block.callId,
      toolName: block.name,
      openFile: () => {},
      loadImage: () => Promise.resolve(''),
      useDisclosure: mockDisclosure(),
      t,
    }
    const view = render(<SubagentToolView {...props} />)
    expect(view.getByText('Review parser', { selector: ':not([aria-hidden="true"] *)' })).toBeTruthy()
    expect(view.queryByText(/deepseek-chat/)).toBeNull()

    args.append(',"model":"deepseek-chat","reasoning_effort":"high"}')
    args.refresh()
    view.rerender(<SubagentToolView {...props} />)
    expect(view.getByText('Review parser · deepseek-chat (high)', { selector: ':not([aria-hidden="true"] *)' })).toBeTruthy()
  })

  it('renders tool call summary with model and effort from args and expands details', () => {
    const block = toolResult('call-1', 'subagent', JSON.stringify({
      description: 'Review parser',
      prompt: 'Check parser logic',
      model: 'deepseek-chat',
      reasoning_effort: 'max',
    }), 'started subagent child-123')

    const collapsed = render(<SubagentToolView {...toolProps(block)} />)

    expect(collapsed.getByText(/Review parser · 已启动 · deepseek-chat \(max\)/)).toBeTruthy()

    const expanded = render(<SubagentToolView {...toolProps(block, {}, true)} />)

    expect(expanded.getByText('child-123')).toBeTruthy()
    expect(expanded.getByText('deepseek-chat')).toBeTruthy()
    expect(expanded.getByText('max')).toBeTruthy()
    expect(expanded.getByText('Check parser logic')).toBeTruthy()
  })

  it('localizes failed tool status and retains the tool result text', () => {
    const block = {
      ...toolResult('call-error', 'subagent', '{"description":"Review parser"}', 'provider unavailable'),
      isError: true,
    }
    const view = render(<SubagentToolView {...toolProps(block)} />)
    expect(view.getByText('Review parser · 出错')).toBeTruthy()
    expect(view.queryByText(/Error/)).toBeNull()
    view.rerender(<SubagentToolView {...toolProps(block, {}, true)} />)
    expect(view.getByText('provider unavailable')).toBeTruthy()
  })

  it('resolves model from child session when omitted in args', () => {
    const childId = SessionId('child-auto')
    const block = toolResult('call-2', 'subagent_fork', JSON.stringify({
      description: 'Fork task',
      prompt: 'Work independently',
    }), `started subagent ${childId}`)

    const view = render(<SubagentToolView {...toolProps(block, {
      [childId]: {
        ...summary(childId, {
          modelSelection: {
            lastUsed: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: ReasoningEffortId('low') },
            next: null,
          },
        }),
        origin: 'subagent', parentId: SessionId('parent'),
      },
    })} />)

    expect(view.getByText(/Fork task · 已启动 · deepseek-chat \(low\)/)).toBeTruthy()
  })
})

describe('SubagentToolView durable receipt association', () => {
  const parentId = SessionId('parent')
  const childId = SessionId('session-real-child')
  const namedId = SessionId('reviewer')
  const parentCatalog = {
    state: 'ready' as const, error: null,
    values: { subagentCatalog: [{ id: childId, name: 'reviewer', mode: 'continuable' as const, label: 'Review parser', createdAt: 1 }] },
  }
  const childSelection = {
    state: 'ready' as const, error: null,
    values: { modelSelection: {
      lastUsed: null,
      next: { provider: 'inherited-route', model: 'inherited-model', reasoningEffort: ReasoningEffortId('high') },
    } },
  }

  it.each(['subagent', 'subagent_fork'])('shows inherited model and effort for %s with omitted route and effort arguments', (tool) => {
    const block = {
      ...toolResult('named-call', tool, '{"description":"Review parser","prompt":"Check parser"}', 'started subagent reviewer'),
      meta: { kind: 'activation', name: 'reviewer' },
    }
    const byId = { [namedId]: summary(namedId, { modelSelection: {
      lastUsed: { provider: 'wrong-route', model: 'wrong-name-as-id-model' }, next: null,
    } }) }
    const projections = { [parentId]: parentCatalog, [childId]: childSelection }
    const view = render(<SubagentToolView {...toolProps(block, byId, false, projections)} />)
    expect(view.getByText('Review parser · 已启动 · inherited-model (high)')).toBeTruthy()
    expect(view.queryByText(/wrong-name-as-id-model/)).toBeNull()
    view.rerender(<SubagentToolView {...toolProps(block, byId, true, projections)} />)
    expect(view.getByText('子智能体名称:')).toBeTruthy()
    expect(view.getByText('reviewer')).toBeTruthy()
    expect(view.getByText(childId)).toBeTruthy()
    expect(view.getByText('inherited-model')).toBeTruthy()
    expect(view.getByText('high')).toBeTruthy()
  })

  it('updates when the parent catalog arrives and uses descriptor model defaults before the child runs', () => {
    const block = {
      ...toolResult('named-call', 'subagent', '{"description":"Review parser"}', 'started subagent reviewer'),
      meta: { kind: 'activation', name: 'reviewer' },
    }
    const child = { [childId]: summary(childId, { subagent: {
      mode: 'continuable', label: 'Review parser', seq: SessionSeq(1), model: 'inherited-model', reasoningEffort: 'high',
    } }) }
    const view = render(<SubagentToolView {...toolProps(block, child)} />)
    expect(view.queryByText(/inherited-model/)).toBeNull()
    view.rerender(<SubagentToolView {...toolProps(block, child, false, { [parentId]: parentCatalog })} />)
    expect(view.getByText('Review parser · 已启动 · inherited-model (high)')).toBeTruthy()
  })

  it('uses only this parent catalog even when another parent has the same agent name', () => {
    const block = {
      ...toolResult('named-call', 'subagent', '{"description":"Review parser"}', 'started subagent reviewer'),
      meta: { kind: 'activation', name: 'reviewer' },
    }
    const view = render(<SubagentToolView {...toolProps(block, {}, false, {
      [SessionId('other-parent')]: parentCatalog, [childId]: childSelection,
    })} />)
    expect(view.getByText('Review parser · 已启动')).toBeTruthy()
    expect(view.queryByText(/inherited-model/)).toBeNull()
  })

  it.each([
    { text: 'started subagent reviewer', meta: { kind: 'activation', name: 'reviewer' } },
    { text: 'started subagent session-real-child', meta: { kind: 'activation', name: 'missing' } },
    { text: 'started subagent session-real-child', meta: { kind: 'unknown', subagentId: 'session-real-child' } },
    { text: 'started subagent session-real-child', meta: { kind: 'activation', name: 42 } },
    { text: 'started background subagent job session-real-child', meta: undefined },
  ])('does not reinterpret missing, malformed, or background-job associations as Session IDs: $text ($meta)', ({ text, meta }) => {
    const block = { ...toolResult('unassociated', 'subagent', '{"description":"Review parser"}', text), meta }
    const view = render(<SubagentToolView {...toolProps(block, { [namedId]: summary(namedId) }, true, { [childId]: childSelection })} />)
    expect(view.queryByText(/inherited-model/)).toBeNull()
    if (text.startsWith('started background')) expect(view.getByText('后台任务 ID:')).toBeTruthy()
    if (meta?.kind === 'unknown' || (meta !== undefined && 'name' in meta && typeof meta.name === 'number')) {
      expect(view.getByText(text)).toBeTruthy()
    }
  })

  it('resolves verified historical IDs from parent catalog membership without interpreting agent names as IDs', () => {
    const legacy = toolResult('legacy', 'subagent', '{"description":"Review parser"}', `started subagent ${childId}`)
    const projections = { [parentId]: parentCatalog, [childId]: childSelection }
    const view = render(<SubagentToolView {...toolProps(legacy, {}, false, projections)} />)
    expect(view.getByText('Review parser · 已启动 · inherited-model (high)')).toBeTruthy()
    const textOnlyName = toolResult('text-only-name', 'subagent', '{"description":"Review parser"}', 'started subagent reviewer')
    view.rerender(<SubagentToolView {...toolProps(textOnlyName, {}, false, projections)} />)
    expect(view.queryByText(/inherited-model/)).toBeNull()
  })
})

describe('ModelInfoPlugin slot lifecycle', () => {
  it('registers slots on mount and cleans up on dispose', async () => {
    const host = await testRuntime()
    const plugin = await host.mount(ModelInfoPlugin)

    expect(host.slots.entries(LINEAGE_SLOT)).toHaveLength(1)
    expect(host.slots.entries(CATALOG_SLOT)).toHaveLength(1)
    const toolEntries = host.slots.entries(TOOL_SLOT)
    expect(toolEntries.map(e => e.options.key)).toContain('subagent')
    expect(toolEntries.map(e => e.options.key)).toContain('subagent_fork')

    await plugin.dispose()
    expect(host.slots.entries(LINEAGE_SLOT)).toHaveLength(0)
    expect(host.slots.entries(CATALOG_SLOT)).toHaveLength(0)
    expect(host.slots.entries(TOOL_SLOT)).toHaveLength(0)
  })
})
