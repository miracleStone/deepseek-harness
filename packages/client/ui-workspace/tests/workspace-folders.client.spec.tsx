// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps } from '../src/client/contract/slots.ts'
import { en, zh } from '../src/client/locales.ts'
import { WorkspaceFolders } from '../src/client/WorkspaceFolders.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

type Props = ComponentProps<typeof WorkspaceFolders>
const primary = 'F:\\AIProject\\workspace'
const extra = 'G:\\Shared projects\\a-very-long-folder-name-without-breaks\\packages\\shared-components'
const workspace: WorkspaceView = {
  workspaceId: 'workspace' as WorkspaceId, title: 'Workspace', path: primary,
  additionalPaths: [extra], sessionIds: [], createdAt: '0', updatedAt: '0',
}
const withoutExtra: WorkspaceView = { ...workspace, additionalPaths: [] }

function mount(overrides: Partial<Props> = {}) {
  let flow: DirectoryFlowOwnerProps | undefined
  const props: Props = {
    workspaceId: workspace.workspaceId,
    workspace,
    useWorkspaceAccess: allowAllAccess.useWorkspaceAccess,
    addWorkspaceFolder: vi.fn(async () => workspace),
    removeWorkspaceFolder: vi.fn(async () => withoutExtra),
    notifyWorkspaceFolder: vi.fn(),
    useDirectoryFlow: selector => selector(true),
    renderSlot: (_name: string, owner: object) => { flow = owner as DirectoryFlowOwnerProps; return null },
    onClose: vi.fn(),
    t: makeTranslate(en, commonEn),
    ...overrides,
  }
  const view = render(<WorkspaceFolders {...props} />)
  return {
    props, view,
    flow: (): DirectoryFlowOwnerProps => {
      if (flow === undefined) throw new Error('directory-flow slot was not rendered')
      return flow
    },
    rerender: (update: Partial<Props>): void => {
      Object.assign(props, update)
      view.rerender(<WorkspaceFolders {...props} />)
    },
  }
}

function mask(): Element {
  const root = screen.getByRole('dialog', { name: 'Manage workspace folders' }).parentElement
  const element = root?.firstElementChild
  if (element === null || element === undefined) throw new Error('Modal mask missing')
  return element
}

describe('Workspace folder management', () => {
  it.each([
    { dict: en, common: commonEn, title: 'Manage workspace folders', list: 'Folders in Workspace',
      primaryLabel: `Primary folder (cannot remove): ${primary}`, remove: `Remove folder from workspace: ${extra}` },
    { dict: zh, common: commonZh, title: '管理工作区文件夹', list: '“Workspace”的文件夹',
      primaryLabel: `主文件夹（不可移除）：${primary}`, remove: `从工作区移除文件夹：${extra}` },
  ])('shows full paths, protects the primary folder, and localizes $title', ({ dict, common, title, list, primaryLabel, remove }) => {
    mount({ t: makeTranslate(dict, common) })
    const dialog = screen.getByRole('dialog', { name: title })
    const folders = within(dialog).getByRole('list', { name: list })
    expect(within(folders).getByRole('listitem', { name: primaryLabel }).textContent).toContain(primary)
    expect(within(folders).getByText(extra).textContent).toBe(extra)
    expect(within(folders).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([remove])
    expect(within(dialog).getByText(dict['folders.scope'])).toBeTruthy()
    expect(within(dialog).getByText(dict['folders.unlinkOnly'])).toBeTruthy()
  })

  it.each([
    { add: true, remove: false },
    { add: false, remove: true },
    { add: false, remove: false },
  ])('offers folder changes independently by Workspace access (add: $add, remove: $remove)', ({ add, remove }) => {
    const useWorkspaceAccess = vi.fn<Props['useWorkspaceAccess']>((_workspaceId, endpoint) =>
      endpoint === 'workspace/addFolder' ? add : endpoint === 'workspace/removeFolder' && remove)
    const b = mount({ useWorkspaceAccess })
    expect(useWorkspaceAccess).toHaveBeenCalledWith(workspace.workspaceId, 'workspace/addFolder')
    expect(useWorkspaceAccess).toHaveBeenCalledWith(workspace.workspaceId, 'workspace/removeFolder')
    expect(screen.queryByRole('button', { name: 'Add folder' }) !== null).toBe(add)
    expect(screen.queryByRole('button', { name: `Remove folder from workspace: ${extra}` }) !== null).toBe(remove)
    expect(screen.getByText(primary)).toBeTruthy()
    expect(screen.getByText(extra)).toBeTruthy()
    expect(b.props.addWorkspaceFolder).not.toHaveBeenCalled()
    expect(b.props.removeWorkspaceFolder).not.toHaveBeenCalled()
  })

  it('withdraws the picker when add access disappears without changing the registered folders', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(b.flow().open).toBe(true)
    b.rerender({ useWorkspaceAccess: () => false })
    expect(b.flow().open).toBe(false)
    act(() => { b.flow().onPicked('H:\\withdrawn') })
    expect(b.props.addWorkspaceFolder).not.toHaveBeenCalled()
    expect(screen.getByText(extra)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.props.onClose).toHaveBeenCalledOnce()
  })

  it('settles an already submitted unlink after access disappears', async () => {
    const removal = Promise.withResolvers<WorkspaceView>()
    const b = mount({ removeWorkspaceFolder: vi.fn(() => removal.promise) })
    fireEvent.click(screen.getByRole('button', { name: `Remove folder from workspace: ${extra}` }))
    b.rerender({ useWorkspaceAccess: () => false })
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.props.onClose).not.toHaveBeenCalled()
    await act(async () => { removal.resolve(withoutExtra) })
    expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderRemoved' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.props.onClose).toHaveBeenCalledOnce()
  })

  it('keeps a legacy single-folder Workspace unchanged', () => {
    const { additionalPaths: _additionalPaths, ...legacy } = workspace
    const b = mount({ workspace: legacy })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Remove folder/ })).toBeNull()
    expect(b.props.addWorkspaceFolder).not.toHaveBeenCalled()
    expect(b.props.removeWorkspaceFolder).not.toHaveBeenCalled()
  })

  it('keeps keyboard focus inside management when the committed projection removes the pending trigger', async () => {
    const removal = Promise.withResolvers<WorkspaceView>()
    const b = mount({ removeWorkspaceFolder: vi.fn(() => removal.promise) })
    const dialog = screen.getByRole('dialog', { name: 'Manage workspace folders' })
    const remove = within(dialog).getByRole('button', { name: `Remove folder from workspace: ${extra}` })
    remove.focus()
    fireEvent.click(remove)
    b.rerender({ workspace: withoutExtra })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(b.props.onClose).not.toHaveBeenCalled()
    await act(async () => { removal.resolve(withoutExtra) })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(b.props.onClose).toHaveBeenCalledOnce()
  })

  it('unlinks an extra registration only after commitment and ignores dismissal while pending', async () => {
    let settle!: (value: WorkspaceView) => void
    const remove = vi.fn(() => new Promise<WorkspaceView>((resolve) => { settle = resolve }))
    const b = mount({ removeWorkspaceFolder: remove })
    const removeButton = screen.getByRole('button', { name: `Remove folder from workspace: ${extra}` })
    fireEvent.click(removeButton)
    fireEvent.click(removeButton)
    expect(remove).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId, extra)
    expect(screen.getByText(extra)).toBeTruthy()
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: 'Add folder' }).hasAttribute('disabled')).toBe(true)
    expect(removeButton.hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(mask())
    expect(b.props.onClose).not.toHaveBeenCalled()
    await act(async () => { settle(withoutExtra) })
    expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderRemoved' })
    // Only the authoritative list projection changes the rendered folder rows.
    expect(screen.getByText(extra)).toBeTruthy()
    b.rerender({ workspace: withoutExtra })
    expect(screen.queryByText(extra)).toBeNull()
    expect(screen.getByText(primary)).toBeTruthy()
  })

  it('retains every path after a failed unlink and lets the user retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const remove = vi.fn<Props['removeWorkspaceFolder']>().mockRejectedValueOnce(new Error('write denied'))
      .mockResolvedValueOnce(withoutExtra)
    const b = mount({ removeWorkspaceFolder: remove })
    fireEvent.click(screen.getByRole('button', { name: `Remove folder from workspace: ${extra}` }))
    await waitFor(() => { expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderRemoveFailed' }) })
    expect(screen.getByText(extra)).toBeTruthy()
    expect(screen.getByText(primary)).toBeTruthy()
    const button = screen.getByRole('button', { name: `Remove folder from workspace: ${extra}` })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    await waitFor(() => { expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderRemoved' }) })
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('adopts a composed picker result into this Workspace and waits for its committed list', async () => {
    let settle!: (value: WorkspaceView) => void
    const add = vi.fn(() => new Promise<WorkspaceView>((resolve) => { settle = resolve }))
    const b = mount({ workspace: withoutExtra, addWorkspaceFolder: add })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(b.flow().open).toBe(true)
    expect(b.flow().busy).toBe(false)
    act(() => { b.flow().onPicked(extra) })
    expect(add).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId, extra)
    expect(b.flow().busy).toBe(true)
    expect(screen.queryByText(extra)).toBeNull()
    act(() => { b.flow().onCancel(); b.flow().onError('late picker failure') })
    expect(b.flow().open).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.props.onClose).not.toHaveBeenCalled()
    await act(async () => { settle(workspace) })
    expect(b.flow().open).toBe(false)
    expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderAdded' })
    b.rerender({ workspace })
    expect(screen.getByText(extra)).toBeTruthy()
  })

  it('keeps the folder list after picker or adoption failure and allows another choice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const add = vi.fn<Props['addWorkspaceFolder']>().mockRejectedValue(new Error('missing folder'))
    const b = mount({ addWorkspaceFolder: add })
    const openPicker = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Add folder' })) }
    openPicker()
    act(() => { b.flow().onError('chooser unavailable') })
    expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderPickerFailed' })
    expect(b.flow().open).toBe(false)
    openPicker()
    act(() => { b.flow().onPicked('H:\\missing') })
    await waitFor(() => { expect(b.props.notifyWorkspaceFolder).toHaveBeenCalledWith({ kind: 'folderAddFailed' }) })
    expect(screen.getByText(extra)).toBeTruthy()
    expect(screen.getByText(primary)).toBeTruthy()
    openPicker()
    act(() => { b.flow().onCancel() })
    expect(b.flow().open).toBe(false)
    const callsBefore = add.mock.calls.length
    act(() => { b.flow().onPicked('H:\\withdrawn') })
    expect(add).toHaveBeenCalledTimes(callsBefore)
    expect(b.props.onClose).not.toHaveBeenCalled()
  })

  it('withdraws an unloaded picker and keeps removals available without a picker', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    b.rerender({ useDirectoryFlow: selector => selector(false) })
    expect(b.flow().open).toBe(false)
    expect(screen.queryByRole('button', { name: 'Add folder' })).toBeNull()
    expect(screen.getByRole('button', { name: `Remove folder from workspace: ${extra}` }).hasAttribute('disabled')).toBe(false)
  })

  it('lets nested picker Escape close only the picker, then lets Escape close management', () => {
    const b = mount({
      renderSlot: (_name: string, owner: object) => {
        const flow = owner as DirectoryFlowOwnerProps
        return <Modal open={flow.open} onClose={flow.onCancel} title="Test directory picker" closeLabel="Cancel picker" />
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(screen.getByRole('dialog', { name: 'Test directory picker' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Test directory picker' })).toBeNull()
    expect(b.props.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.props.onClose).toHaveBeenCalledOnce()
  })

  it('closes on an idle outside click and names a registration removed by another client', () => {
    const b = mount()
    fireEvent.click(mask())
    expect(b.props.onClose).toHaveBeenCalledOnce()
    b.rerender({ workspace: undefined })
    expect(screen.getByRole('alert').textContent).toBe(en['folders.unavailable'])
    expect(screen.getByRole('button', { name: 'Add folder' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.props.onClose).toHaveBeenCalledTimes(2)
  })
})
