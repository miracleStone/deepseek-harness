/** Durable additional workspace directories captured for one Session. */

import { isAbsolute } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Additional writable project directories, independent of the active working directory. */
    'sandbox/workspace-roots': {
      /** Absolute directory paths approved when the Session or delegated child was created. */
      additionalWorkspaceRoots: string[]
    }
  }
}

/**
 * Record additional workspace directories without changing the working directory or sandbox mode.
 * Callers own approval and supply filesystem-canonical directories, including the
 * Session's primary cwd. Canonicalization happens at approval, not during later
 * grant reduction; this function rejects relative paths before appending anything.
 * @param session - Session whose subsequent operations use these roots.
 * @param roots - Complete canonical additional root list; an empty list clears the extra grants.
 */
export function setSandboxWorkspaceRoots(session: Session, roots: readonly string[]): void {
  for (const root of roots) {
    if (!isAbsolute(root)) throw new TypeError('sandbox-policy: additional workspace roots must be absolute')
  }
  const additionalWorkspaceRoots = [...new Set(roots)].filter(root => root !== session.header.cwd)
  session.append('sandbox/workspace-roots', { additionalWorkspaceRoots })
}
