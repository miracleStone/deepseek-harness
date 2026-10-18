/** Workspace folder registration dialog; committed folder data stays in the Workspace model. */
import { useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconFolderCloseRegular, IconPlusOutlineRegular, IconCloseOutlineRegular, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './WorkspaceFolders.module.css'

type WorkspaceFoldersProps = Pick<WorkspaceBrowserProps,
  'addWorkspaceFolder' | 'removeWorkspaceFolder' | 'notifyWorkspaceFolder' | 'useDirectoryFlow' | 'useWorkspaceAccess' | 't'
> & PropsRenderSlots<'sidebar.workspaces.directoryFlow'> & {
  /** Workspace resource being managed, retained even if its model row disappears. */
  workspaceId: WorkspaceView['workspaceId']
  /** Current model row; absence means another client removed the registration while this dialog was open. */
  workspace: WorkspaceView | undefined
  onClose: () => void
}

/**
 * Manage additional folders without editing the primary folder or existing conversations.
 * @param props - Current committed Workspace, mutation callbacks, and the existing directory-flow slot.
 * @returns The shared Modal and its composed directory picker.
 */
export function WorkspaceFolders({
  workspaceId, workspace, addWorkspaceFolder, removeWorkspaceFolder, notifyWorkspaceFolder,
  useDirectoryFlow, useWorkspaceAccess, renderSlot, onClose, t,
}: WorkspaceFoldersProps) {
  const canAddFolder = useWorkspaceAccess(workspaceId, 'workspace/addFolder')
  const canRemoveFolder = useWorkspaceAccess(workspaceId, 'workspace/removeFolder')
  const [operation, setOperation] = useState<'idle' | 'picking' | 'adding' | 'removing'>('idle')
  const folders = useRef<HTMLUListElement>(null)
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An unloaded picker cannot settle an open request; withdrawing it does not cancel a committed mutation.
  if (operation === 'picking' && (!flowAvailable || !canAddFolder || workspace === undefined)) setOperation('idle')
  const pending = operation === 'adding' || operation === 'removing'
  const busy = operation !== 'idle'
  const close = (): void => { if (!busy) onClose() }
  const changeFolder = async (target: WorkspaceView, action: 'add' | 'remove', path: string): Promise<void> => {
    setOperation(action === 'add' ? 'adding' : 'removing')
    try {
      await (action === 'add' ? addWorkspaceFolder : removeWorkspaceFolder)(target.workspaceId, path)
    } catch (reason: unknown) {
      console.warn('workspace folder change rejected:', reason)
      notifyWorkspaceFolder({ kind: action === 'add' ? 'folderAddFailed' : 'folderRemoveFailed' })
      setOperation('idle')
      return
    }
    notifyWorkspaceFolder({ kind: action === 'add' ? 'folderAdded' : 'folderRemoved' })
    setOperation('idle')
  }

  return (
    <>
      <Modal
        open
        onClose={close}
        closeLabel={t('close')}
        title={t('folders.title')}
        description={t('folders.scope')}
        className={clsx(css.dialog)}
        contentClassName={clsx(css.content)}
        footer={(
          <div className={css.actions}>
            {flowAvailable && canAddFolder && (
              <Button variant="outline" disabled={busy || workspace === undefined}
                icon={<IconPlusOutlineRegular />} onClick={() => { setOperation('picking') }}>
                {t('folders.add')}
              </Button>
            )}
            <Button variant="primary" disabled={busy} onClick={close}>{t('close')}</Button>
          </div>
        )}
      >
        {workspace === undefined
          ? <p className={css.notice} role="alert">{t('folders.unavailable')}</p>
          : <>
            <p className={css.workspaceName}>{workspace.title}</p>
            <ul ref={folders} tabIndex={-1} className={css.folders}
              aria-label={t('folders.list', { name: workspace.title })} aria-busy={pending}>
              <li className={css.folder} aria-label={t('folders.primary.aria', { path: workspace.path })}>
                <IconFolderCloseRegular className={css.folderIcon} />
                <div className={css.folderText}>
                  <span className={css.primary}>{t('folders.primary')}</span>
                  <span className={css.path}>{workspace.path}</span>
                </div>
              </li>
              {(workspace.additionalPaths ?? []).map(path => (
                <li key={path} className={css.folder} aria-label={path}>
                  <IconFolderCloseRegular className={css.folderIcon} />
                  <span className={css.path}>{path}</span>
                  {canRemoveFolder && <Tooltip label={t('folders.remove')} portal>
                    <Button variant="ghost" size="sm" className={css.remove}
                      disabled={busy} aria-label={t('folders.remove.aria', { path })}
                      onClick={(event) => {
                        // Removal disables and can unmount its trigger; keep keyboard input in this dialog.
                        if (event.currentTarget.ownerDocument.activeElement === event.currentTarget) {
                          folders.current?.focus({ preventScroll: true })
                        }
                        void changeFolder(workspace, 'remove', path)
                      }}>
                      <IconCloseOutlineRegular />
                    </Button>
                  </Tooltip>}
                </li>
              ))}
            </ul>
            <p className={css.notice}>{t('folders.unlinkOnly')}</p>
            <div className={css.status} role="status">{pending ? t('folders.pending') : null}</div>
          </>}
      </Modal>
      {renderSlot('sidebar.workspaces.directoryFlow', {
        open: operation === 'picking' || operation === 'adding',
        busy: operation === 'adding',
        onPicked: (path) => {
          if (operation === 'picking' && workspace !== undefined) void changeFolder(workspace, 'add', path)
        },
        onCancel: () => { if (operation === 'picking') setOperation('idle') },
        onError: (message) => {
          if (operation !== 'picking') return
          console.warn('workspace folder picker failed:', message)
          setOperation('idle')
          notifyWorkspaceFolder({ kind: 'folderPickerFailed' })
        },
      })}
    </>
  )
}
