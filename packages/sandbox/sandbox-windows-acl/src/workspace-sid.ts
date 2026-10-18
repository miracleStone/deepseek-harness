/**
 * Deterministic workspace write identities. One canonical root set shares
 * a capability across sessions, calls, and restarts; standing ACEs on each
 * root let later provisions skip tree propagation. Different root sets
 * carry different capabilities, so removing a root cannot retain its grant.
 * Inputs must be canonical paths (`realpathSync.native`); renaming a root
 * derives a new identity and leaves the old standing ACEs inert.
 *
 * Private temp directories use separate per-directory identities. Sharing
 * the workspace identity with temp would authorize sibling sessions' writes.
 * SID strings are identifiers, not secrets; their authority comes from ACEs.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/workspace-sid
 */

import { createHash } from 'node:crypto'

/**
 * Derive a workspace-root set's write SID (`S-1-4-x-y`; 30-bit subauthorities).
 * A single canonical path retains its identity; arrays are sorted and deduplicated.
 * @param workspaceRoot - one canonical workspace path or a non-empty set of canonical paths.
 * @returns the SDDL string form; throws for an empty root set.
 */
export function workspaceWriteSid(workspaceRoot: string | readonly string[]): string {
  const roots = typeof workspaceRoot === 'string' ? [workspaceRoot] : [...new Set(workspaceRoot)].sort()
  const firstRoot = roots[0]
  if (firstRoot === undefined) throw new Error('workspaceWriteSid requires at least one workspace root')
  const identity = roots.length === 1 ? firstRoot : `workspace-set\0${JSON.stringify(roots)}`
  const digest = createHash('sha256').update(identity, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * Derive one private temp directory's write SID. The random directory path
 * is the capability identity; a fixed third subauthority domain-separates
 * the result from every two-subauthority workspace SID.
 * @param tempDir - the private temp directory's absolute path.
 * @returns the SDDL string form.
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}
