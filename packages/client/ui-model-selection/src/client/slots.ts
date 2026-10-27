/** Composer model selection injection and inline model extensions. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from './directory.ts'

/** Catalog data for a model name inside the composer's existing controls. */
export interface ModelLabelOwner {
  /** Provider identity and localized display name; contains no connection configuration. */
  provider: Pick<ModelProviderGroup, 'id' | 'name'>
  /** The exact provider's model catalog entry. */
  model: ModelCatalogModel
  /** Trigger caption, root-menu current value, or selectable model row. */
  placement: 'trigger' | 'menu' | 'option'
  /** Whether this provider/model pair is the current selection. */
  selected: boolean
}

/** Exact selected model identity for additive, non-interactive trigger status content. */
export interface ModelStatusOwner {
  /** Selected provider route; contains no connection configuration. */
  provider: ModelSelection['provider']
  /** Selected model id within that provider. */
  model: ModelSelection['model']
}

/** Current model identity and interaction state for root-menu option contributions. */
export interface ModelOptionsOwner {
  /** Selected provider route, or undefined before a selection; contains no connection configuration. */
  provider: ModelSelection['provider'] | undefined
  /** Selected model id within that provider, or undefined before a selection. */
  model: ModelSelection['model'] | undefined
  /** Whether the composer refuses changes, including while a model selection is pending. */
  locked: boolean
  /** Whether a model or reasoning selection is awaiting confirmation. */
  busy: boolean
  /** Close the menu and focus its trigger synchronously before opening another overlay. */
  dismiss: () => void
  /** Report a localized action failure through the menu owner's persistent toast. */
  reportFailure: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Additive non-interactive inline status content after the trigger's reasoning effort. */
    'conversation.input.model.status': {
      kind: 'list'
      scope: 'session'
      inline: true
      owner: ModelStatusOwner
    }
    /**
     * Additive root-menu option rows after the reasoning control.
     * Contributions use menuitem, menuitemradio, menuitemcheckbox, or switch buttons;
     * disabled rows are excluded from the owner's keyboard navigation.
     */
    'conversation.input.model.options': {
      kind: 'list'
      scope: 'session'
      owner: ModelOptionsOwner
    }
    /**
     * Non-interactive inline model label; selection controls remain owner-managed.
     * Without a contribution, the badge precedes the catalog name in the trigger
     * and follows it in menus.
     * @example
     * return {
     *   inject: ['slots'],
     *   apply(ctx) {
     *     ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register(
     *       { name: 'conversation.input.model.label' },
     *       ({ provider, model }) => React.createElement('span', { title: provider.name }, model.name),
     *     ))
     *   },
     * }
     */
    'conversation.input.model.label': {
      kind: 'single'
      scope: 'session'
      inline: true
      owner: ModelLabelOwner
    }
  }
}

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  load: () => void
  /**
   * Choose a catalog badge's provider-authored text for the active locale.
   * @param text - the badge's literal text or translations.
   * @returns the text to display.
   */
  resolveText: (text: NonNullable<ModelCatalogModel['badge']>['text']) => string
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns the Host outcome, or undefined when this Session cannot select a model.
   */
  select: (selection: ModelSelection) => Promise<RemoteResult<void> | undefined>
}
