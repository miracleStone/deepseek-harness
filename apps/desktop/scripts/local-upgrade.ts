/** Fail-closed local Windows upgrade planning and transaction ordering; native operations are injected. */
import { win32 } from 'node:path'

/** Explicit machine-local consent; never configures a release feed or a renderer installer API. */
export interface LocalUpgradeConsent {
  readonly schemaVersion: 1
  readonly mode: 'personal-unsigned'
  readonly repository: string
  readonly executable: string
  readonly home: string
  readonly userData: string
  readonly workRoot: string
  readonly appId: string
  readonly packageName: '@deepseek-ai/dsh-desktop'
  readonly uninstallKey: string
  readonly allowAutomaticLocalVersions: boolean
  readonly allowTaskInterruption: true
  readonly deadlineMs: number
}

/** PID reuse is rejected by comparing the Windows process creation FILETIME as well as its executable. */
export interface LocalUpgradeProcess {
  readonly pid: number
  readonly created: string
  readonly executable: string
  readonly parent: number
}

/** A captured open turn, not an idle flag or a timestamp heuristic. */
export interface LocalUpgradeTurn {
  readonly sessionId: string
  readonly file: string
  readonly version: number
  readonly turn: number
  readonly startSeq: number
}

/** Installer and application bytes inspected before the external worker is armed. */
export interface LocalUpgradeArtifact {
  readonly version: string
  readonly runtimeVersion: string
  readonly installer: string
  readonly installerHash: string
  readonly executableHash: string
  readonly asarHash: string
}

/** Immutable, private instructions consumed by one externally owned worker. */
export interface LocalUpgradePlan {
  readonly schemaVersion: 1
  readonly id: string
  readonly consent: LocalUpgradeConsent
  readonly run: string
  readonly artifact: LocalUpgradeArtifact
  readonly previous: { readonly version: string; readonly executableHash: string; readonly asarHash: string }
  readonly main: LocalUpgradeProcess
  readonly processes: readonly LocalUpgradeProcess[]
  readonly gate: LocalUpgradeTurn
}

/** Credential-free failure identity; adapter diagnostics stay in the private run directory. */
export class LocalUpgradeError extends Error {
  /** @param code Stable failure stage, never inferred from translated or operating-system messages. */
  constructor(readonly code: string) { super(`local Desktop upgrade: ${code}`) }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalUpgradeError('invalid-record')
  return value as Record<string, unknown>
}

/**
 * Require a canonical fixed-drive path without root, stream, device, or traversal syntax.
 * @param value Untrusted configuration path.
 * @returns The normalized absolute Windows path; filesystem links are checked separately by the adapter.
 */
export function localUpgradePath(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]:\\/iu.test(value) || /[\x00-\x1f<>:"|?*]/u.test(value.slice(2))
    || value.slice(3).split('\\').some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) throw new LocalUpgradeError('unsafe-path')
  const normalized = win32.normalize(value)
  if (normalized === win32.parse(normalized).root || normalized !== value) throw new LocalUpgradeError('unsafe-path')
  return normalized
}

/**
 * Compare Windows paths by directory components, not a textual prefix.
 * @param parent Approved directory.
 * @param candidate Candidate directory or file.
 * @returns Whether candidate equals parent or is beneath it.
 */
export function localUpgradeWithin(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent.toLowerCase(), candidate.toLowerCase())
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative))
}

/**
 * Validate exact opt-in and mutually separate data, installation, checkout, and worker roots.
 * @param input Parsed machine-owned JSON.
 * @returns Validated consent. Unknown fields are refused to catch misspelled safety settings.
 */
export function parseLocalUpgradeConsent(input: unknown): LocalUpgradeConsent {
  const value = record(input)
  const keys = ['schemaVersion', 'mode', 'repository', 'executable', 'home', 'userData', 'workRoot', 'appId', 'packageName',
    'uninstallKey', 'allowAutomaticLocalVersions', 'allowTaskInterruption', 'deadlineMs']
  if (Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== 1 || value.mode !== 'personal-unsigned'
    || value.packageName !== '@deepseek-ai/dsh-desktop' || value.allowTaskInterruption !== true
    || typeof value.allowAutomaticLocalVersions !== 'boolean' || typeof value.appId !== 'string'
    || typeof value.uninstallKey !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value.uninstallKey)
    || !/^[a-z][a-z0-9.-]+$/iu.test(value.appId) || typeof value.deadlineMs !== 'number'
    || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 60_000 || value.deadlineMs > 86_400_000) {
    throw new LocalUpgradeError('invalid-consent')
  }
  const repository = localUpgradePath(value.repository)
  const executable = localUpgradePath(value.executable)
  const home = localUpgradePath(value.home)
  const userData = localUpgradePath(value.userData)
  const workRoot = localUpgradePath(value.workRoot)
  if (win32.basename(executable) !== 'DeepSeek Harness.exe') throw new LocalUpgradeError('unexpected-executable')
  const roots = [repository, win32.dirname(executable), home, userData, workRoot]
  for (const [index, left] of roots.entries()) for (const right of roots.slice(index + 1)) {
    if (localUpgradeWithin(left, right) || localUpgradeWithin(right, left)) throw new LocalUpgradeError('overlapping-roots')
  }
  return { schemaVersion: 1, mode: 'personal-unsigned', repository, executable, home, userData, workRoot,
    packageName: '@deepseek-ai/dsh-desktop', appId: value.appId, uninstallKey: value.uninstallKey,
    allowAutomaticLocalVersions: value.allowAutomaticLocalVersions, allowTaskInterruption: true, deadlineMs: value.deadlineMs }
}

/**
 * Validate a staged worker manifest again before any native operation.
 * @param input Parsed private plan JSON.
 * @returns A validated plan whose mutable targets stay within its explicitly consented roots.
 */
export function parseLocalUpgradePlan(input: unknown): LocalUpgradePlan {
  const value = record(input)
  const consent = parseLocalUpgradeConsent(value.consent)
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id)) throw new LocalUpgradeError('invalid-plan')
  const run = localUpgradePath(value.run)
  if (win32.dirname(run).toLowerCase() !== consent.workRoot.toLowerCase()
    || win32.basename(run) !== value.id) throw new LocalUpgradeError('run-outside-consent')
  const artifact = record(value.artifact)
  const previous = record(value.previous)
  for (const hash of [artifact.installerHash, artifact.executableHash, artifact.asarHash, previous.executableHash, previous.asarHash]) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) throw new LocalUpgradeError('invalid-hash')
  }
  const version = (input: unknown): string => {
    if (typeof input !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(input)) throw new LocalUpgradeError('invalid-version')
    return input
  }
  const process = (input: unknown): LocalUpgradeProcess => {
    const item = record(input)
    if (typeof item.pid !== 'number' || !Number.isSafeInteger(item.pid) || item.pid <= 0
      || typeof item.parent !== 'number' || !Number.isSafeInteger(item.parent) || item.parent < 0
      || typeof item.created !== 'string' || !/^\d{10,20}$/u.test(item.created)
      || localUpgradePath(item.executable).toLowerCase() !== consent.executable.toLowerCase()) throw new LocalUpgradeError('invalid-process')
    return { pid: item.pid, parent: item.parent, created: item.created, executable: consent.executable }
  }
  const main = process(value.main)
  if (!Array.isArray(value.processes) || value.processes.length === 0) throw new LocalUpgradeError('missing-processes')
  const processes = value.processes.map(process)
  if (new Set(processes.map(item => item.pid)).size !== processes.length
    || !processes.some(item => item.pid === main.pid && item.created === main.created)) throw new LocalUpgradeError('invalid-processes')
  const gate = record(value.gate)
  const file = localUpgradePath(gate.file)
  if (!localUpgradeWithin(win32.join(consent.home, 'sessions'), file)
    || typeof gate.sessionId !== 'string' || !/^session-[a-z0-9-]+$/u.test(gate.sessionId)
    || win32.basename(win32.dirname(file)) !== gate.sessionId
    || !/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/u.test(win32.basename(file))
    || typeof gate.version !== 'number' || !Number.isSafeInteger(gate.version) || gate.version < 0 || gate.version > 4
    || typeof gate.turn !== 'number' || !Number.isSafeInteger(gate.turn) || gate.turn < 0
    || typeof gate.startSeq !== 'number' || !Number.isSafeInteger(gate.startSeq) || gate.startSeq < 0) throw new LocalUpgradeError('invalid-turn-gate')
  const generation = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/u.exec(win32.basename(file))
  if (Number(generation?.[1] ?? 0) !== gate.version) throw new LocalUpgradeError('session-filename-version-differ')
  if (localUpgradePath(artifact.installer) !== win32.join(run, 'installer.exe')) throw new LocalUpgradeError('installer-outside-run')
  return { schemaVersion: 1, id: value.id, consent, run, main, processes,
    artifact: { version: version(artifact.version), runtimeVersion: version(artifact.runtimeVersion),
      installer: artifact.installer as string, installerHash: artifact.installerHash as string,
      executableHash: artifact.executableHash as string, asarHash: artifact.asarHash as string },
    previous: { version: version(previous.version), executableHash: previous.executableHash as string,
      asarHash: previous.asarHash as string },
    gate: { sessionId: gate.sessionId, file, version: gate.version, turn: gate.turn, startSeq: gate.startSeq } }
}

interface TurnRow { readonly type: string; readonly seq: number; readonly data: Record<string, unknown> }
function sessionRows(text: string, sessionId: string): { version: number; rows: TurnRow[] } {
  if (!text.endsWith('\n')) throw new LocalUpgradeError('incomplete-session-tail')
  const values = text.trimEnd().split('\n').map(line => record(JSON.parse(line)))
  const header = values.shift()
  if (header?.type !== 'session' || header.id !== sessionId || typeof header.version !== 'number'
    || !Number.isSafeInteger(header.version) || header.version < 0 || header.version > 4) throw new LocalUpgradeError('unsupported-session')
  let sequence = -1
  const rows = values.map((value) => {
    if (typeof value.type !== 'string' || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq)
      || value.seq !== sequence + 1) throw new LocalUpgradeError('invalid-session-sequence')
    sequence = value.seq
    return { type: value.type, seq: value.seq, data: record(value.data) }
  })
  return { version: header.version, rows }
}

/**
 * Capture only an actually open turn in a stable physical Session generation.
 * @param text Complete decoded JSONL snapshot.
 * @param sessionId Exact current session ID.
 * @param file Canonical generation file selected by the caller.
 * @returns The open turn; already-idle or malformed sessions cannot arm a future shutdown.
 */
export function captureLocalUpgradeTurn(text: string, sessionId: string, file: string): LocalUpgradeTurn {
  const { version, rows } = sessionRows(text, sessionId)
  const start = rows.findLast(row => row.type === 'turn/start')
  if (start === undefined || typeof start.data.turn !== 'number' || !Number.isSafeInteger(start.data.turn)
    || rows.some(row => row.seq > start.seq && row.type === 'turn/end')) throw new LocalUpgradeError('no-open-turn')
  return { sessionId, file, version, turn: start.data.turn, startSeq: start.seq }
}

/**
 * Require the captured turn's real successful end; a later turn cancels the handoff rather than interrupting it.
 * @param text Stable complete decoded Session snapshot.
 * @param gate Captured turn identity.
 * @returns Whether the exact completed turn/end is durable; aborts, replacements, and subsequent turns reject.
 */
export function localUpgradeTurnEnded(text: string, gate: LocalUpgradeTurn): boolean {
  const { version, rows } = sessionRows(text, gate.sessionId)
  if (version !== gate.version) throw new LocalUpgradeError('session-generation-changed')
  const start = rows.find(row => row.seq === gate.startSeq)
  if (start?.type !== 'turn/start' || start.data.turn !== gate.turn) throw new LocalUpgradeError('session-turn-changed')
  if (rows.some(row => row.seq > gate.startSeq && row.type === 'turn/start')) throw new LocalUpgradeError('next-turn-started')
  const end = rows.find(row => row.seq > gate.startSeq && row.type === 'turn/end')
  if (end === undefined) return false
  if (end.data.turn !== gate.turn || record(end.data.reason).kind !== 'completed') throw new LocalUpgradeError('turn-not-completed')
  return true
}

/**
 * Build only the supported NSIS update invocation; the directory option must be last.
 * @param executable Exact consented installed executable.
 * @returns Argument array for shell-free installer execution.
 */
export function localUpgradeInstallerArguments(executable: string): readonly string[] {
  return ['--updated', '/KEEP_APP_DATA', '/S', `/D=${win32.dirname(localUpgradePath(executable))}`]
}

/** Ordered external operations; each method must finish its owned work before resolving. */
export interface LocalUpgradeOperations {
  /** Flush a credential-free event before the corresponding operation. */
  event: (stage: string) => Promise<void>
  /** Check immutable staged bytes, path/ACL fences, and exact process identities without stopping anything. */
  verify: () => Promise<void>
  /** Await exact durable turn/end and reject a later turn or deadline. */
  waitForTurn: () => Promise<void>
  /** Restart Manager flags=0; reject a refused shutdown; never force or target an unrelated process. */
  stop: () => Promise<void>
  /** Confirm every captured application/Host process exited and no replacement is using the installation. */
  quiescent: () => Promise<void>
  /** Copy and verify installation, Harness home and Electron data after all owners exit. */
  backup: () => Promise<void>
  /** Run staged NSIS and await its actual exit. Nonzero status rejects. */
  install: () => Promise<void>
  /** Determine whether successor code started, including an uncertain installer outcome. */
  successorStarted: () => Promise<boolean>
  /** Verify installed bytes/version, a responsive UI, an authenticated startup receipt and offline CLI version. */
  health: () => Promise<void>
  /** Restore only the verified old application when no successor has started; never restore live user data. */
  rollback: () => Promise<void>
  /** Relaunch the old application after a prelaunch installation failure or failed backup. */
  relaunchPrevious: () => Promise<void>
}

/**
 * Execute one handoff with no destructive operation before the durable gate.
 * @param operations Instance-owned Windows adapter; failures retain private evidence and backups.
 * @returns Resolves only after installed health checks. Postlaunch failure never downgrades or overwrites data.
 */
export async function executeLocalUpgrade(operations: LocalUpgradeOperations): Promise<void> {
  await operations.event('verify')
  await operations.verify()
  await operations.event('waiting-for-turn')
  await operations.waitForTurn()
  // A process or installer may have changed during the wait; validation must precede shutdown again.
  await operations.verify()
  await operations.event('graceful-stop')
  await operations.stop()
  await operations.quiescent()
  let installing = false
  try {
    await operations.event('backup')
    await operations.backup()
    await operations.event('install')
    installing = true
    await operations.install()
  } catch (error) {
    if (await operations.successorStarted()) {
      await operations.event('failed-after-successor-start')
      throw error
    }
    if (installing) { await operations.event('rollback-application'); await operations.rollback() }
    await operations.relaunchPrevious()
    throw error
  }
  await operations.event('health')
  try { await operations.health() }
  catch (error) { await operations.event('failed-after-successor-start'); throw error }
  await operations.event('complete')
}
