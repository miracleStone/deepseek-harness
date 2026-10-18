/** Optional private startup evidence; it never carries Host URLs, authentication, or renderer operations. */
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'

/** Nonsecret startup facts checked against the upgrade worker's nonce, version, and live process identities. */
export interface DesktopStartupReadiness {
  readonly schemaVersion: 1
  readonly nonce: string
  readonly version: string
  readonly mainPid: number
  readonly hostPid: number
}

/** Trusted local launch request; the parent directory must already exist and be privately owned by the launcher. */
export interface DesktopStartupReceiptTarget {
  readonly file: string
  readonly nonce: string
}

/**
 * Resolve an explicitly requested private startup receipt without enabling a network endpoint.
 * @param environment Local process environment; both fields must be supplied together.
 * @returns Validated target, or undefined when no receipt was requested. Invalid requests fail before Host startup.
 */
export function resolveDesktopStartupReceiptTarget(environment: NodeJS.ProcessEnv): DesktopStartupReceiptTarget | undefined {
  const file = environment.DSH_DESKTOP_READY_RECEIPT
  const nonce = environment.DSH_DESKTOP_READY_NONCE
  if (file === undefined && nonce === undefined) return undefined
  if (file === undefined || nonce === undefined || !isAbsolute(file) || normalize(file) !== file
    || basename(file) !== 'desktop-ready.json' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(nonce)) {
    throw new Error('Desktop startup receipt requires an absolute desktop-ready.json path and a UUID nonce; restart without both overrides to disable it.')
  }
  return { file, nonce }
}

function plainParents(file: string): void {
  for (let cursor = dirname(file); ; cursor = dirname(cursor)) {
    const entry = lstatSync(cursor)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Desktop startup receipt refuses linked or missing parent directories.')
    if (dirname(cursor) === cursor) return
  }
}

/**
 * Owns one private receipt file until Host invalidation or quit. Publication is synchronous and exclusive;
 * failure never replaces an existing file. Callers report I/O failures and must still finish Host teardown.
 */
export class DesktopStartupReceipt {
  private publication: { readonly hostPid: number; readonly content: string } | undefined

  /**
   * @param target Validated local launch request, never a renderer input.
   * @param identity Actual Electron process identity and packaged version.
   */
  constructor(
    private readonly target: DesktopStartupReceiptTarget,
    private readonly identity: { readonly mainPid: number; readonly version: string },
  ) {}

  /**
   * Publish only after authenticated Host bootstrap and initial document navigation complete.
   * @param hostPid PID of the actual ready child; changing children revokes the previous receipt first.
   */
  publish(hostPid: number): void {
    if (this.publication?.hostPid === hostPid) return
    this.revoke()
    plainParents(this.target.file)
    const value: DesktopStartupReadiness = { schemaVersion: 1, nonce: this.target.nonce,
      version: this.identity.version, mainPid: this.identity.mainPid, hostPid }
    const content = `${JSON.stringify(value)}\n`
    writeFileSync(this.target.file, content, { flag: 'wx', mode: 0o600, flush: true })
    this.publication = { hostPid, content }
  }

  /** Remove only this owner's unchanged receipt; a missing file is already revoked and a foreign file is left in place. */
  revoke(): void {
    if (this.publication === undefined) return
    try {
      plainParents(this.target.file)
      if (lstatSync(this.target.file).isSymbolicLink() || readFileSync(this.target.file, 'utf8') !== this.publication.content) {
        throw new Error('Desktop startup receipt changed ownership; the file was not removed.')
      }
      unlinkSync(this.target.file)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    this.publication = undefined
  }
}
