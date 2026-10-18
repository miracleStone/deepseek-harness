/** Self-contained worker staged with its own Node executable; no import reaches the live installation. */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { zstdDecompressSync } from 'node:zlib'
import {
  executeLocalUpgrade, LocalUpgradeError, localUpgradeInstallerArguments, localUpgradeTurnEnded,
  parseLocalUpgradePlan, type LocalUpgradeConsent, type LocalUpgradeProcess,
} from './local-upgrade.ts'
import type { DesktopStartupReadiness } from '../src/startup-receipt.ts'

/** Hash file bytes without retaining secrets or complete executables in memory.
 * @param file Existing local file.
 * @returns Lowercase SHA-256.
 */
export async function localUpgradeHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Native helper response; no raw exception, environment, or command line is returned. */
export interface LocalUpgradeInspection {
  readonly processes: readonly LocalUpgradeProcess[]
  readonly roots: readonly number[]
  readonly hosts: readonly number[]
  readonly ports: readonly number[]
  readonly responsive: boolean
}

/**
 * Invoke the copied native helper using private files and shell-free arguments.
 * @param helper Absolute PowerShell helper path.
 * @param directory Private operation-record directory.
 * @param operation Fixed helper operation.
 * @param input Operation-specific JSON; never credential contents.
 * @returns Validated successful JSON result. A native failure stops dependent work.
 */
export async function localUpgradeNative(
  helper: string, directory: string, operation: string, input: object,
): Promise<Record<string, unknown>> {
  const id = randomUUID()
  const request = join(directory, `native-${id}.request.json`)
  const output = join(directory, `native-${id}.response.json`)
  await writeFile(request, JSON.stringify(input), { flag: 'wx', mode: 0o600, flush: true })
  try {
    await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', helper, '-Operation', operation, '-InputFile', request, '-OutputFile', output],
      { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024, env: cleanEnvironment() })
  } catch { throw new LocalUpgradeError(`native-${operation}-failed`) }
  const value: unknown = JSON.parse((await readFile(output, 'utf8')).replace(/^\uFEFF/u, ''))
  if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true
    || !('result' in value) || typeof value.result !== 'object' || value.result === null || Array.isArray(value.result)) {
    throw new LocalUpgradeError(`native-${operation}-invalid-result`)
  }
  return value.result as Record<string, unknown>
}

/**
 * Decode one stable, highest physical generation without repairing or writing it.
 * @param file Exact captured JSONL or Zstandard generation.
 * @returns Complete decoded records; a changing/incomplete file must be read again before shutdown.
 */
export async function readLocalUpgradeSession(file: string): Promise<string> {
  const versions = (await readdir(dirname(file))).flatMap((name) => {
    const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/u.exec(name)
    return match === null ? [] : [{ name, version: Number(match[1] ?? 0) }]
  }).sort((left, right) => right.version - left.version)
  if (versions.length === 0 || versions[0]!.name !== win32.basename(file)
    || (versions[1] !== undefined && versions[0]!.version === versions[1].version)) throw new LocalUpgradeError('session-generation-changed')
  const before = await stat(file, { bigint: true })
  const bytes = await readFile(file)
  const after = await stat(file, { bigint: true })
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new LocalUpgradeError('session-read-raced')
  try {
    if (!file.endsWith('.zstd')) return bytes.toString('utf8')
    const frames: Buffer[] = []
    let offset = 0
    while (offset < bytes.length) {
      // Node decodes one frame; its declarations omit the documented info result.
      const decoded: unknown = zstdDecompressSync(bytes.subarray(offset), { info: true })
      if (typeof decoded !== 'object' || decoded === null || !('buffer' in decoded) || !Buffer.isBuffer(decoded.buffer)
        || !('engine' in decoded) || typeof decoded.engine !== 'object' || decoded.engine === null
        || !('bytesWritten' in decoded.engine) || typeof decoded.engine.bytesWritten !== 'number'
        || !Number.isSafeInteger(decoded.engine.bytesWritten) || decoded.engine.bytesWritten <= 0
        || decoded.engine.bytesWritten > bytes.length - offset) throw new LocalUpgradeError('invalid-zstd-frame')
      frames.push(decoded.buffer)
      offset += decoded.engine.bytesWritten
    }
    return Buffer.concat(frames).toString('utf8')
  } catch { throw new LocalUpgradeError('incomplete-session-tail') }
}

/**
 * Remove credentials and launcher routing before a native helper, installer, or offline CLI probe.
 * @param environment Current process environment, never modified or serialized.
 * @param home Optional installer/probe Harness home pin.
 * @returns A clean environment; provider secrets are intentionally unavailable to these operations.
 */
export function localUpgradeHelperEnvironment(environment: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^ELECTRON_|^DSH_/iu.test(name))),
  ...(home === undefined ? {} : { DSH_HOME: home }) }
}

/**
 * Retain the logged-in user's provider environment only for the trusted Desktop process.
 * @param environment Fresh Scheduled Task environment; process-only values from the old Host are not recoverable.
 * @param paths Explicit machine-consented data roots.
 * @returns In-memory launch values with both data roots pinned and parent/runtime routing removed; never stage or log them.
 */
export function localUpgradeProductEnvironment(
  environment: NodeJS.ProcessEnv, paths: Pick<LocalUpgradeConsent, 'home' | 'userData'>,
): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !/^DSH_|^ELECTRON_|^NODE_OPTIONS$|^NODE_PATH$|^npm_(?:execpath$|node_execpath$|lifecycle_)/iu.test(name))),
  DSH_HOME: paths.home, DSH_DESKTOP_USER_DATA_DIR: paths.userData }
}

/**
 * Pin Chromium browser storage even though the packaged shell does not read the development-only environment override.
 * @param userData Machine-consented Electron user-data directory.
 * @param updated Whether this is the successful update's first launch.
 * @returns Shell-free product arguments, never provider credentials.
 */
export function localUpgradeProductArguments(userData: string, updated: boolean): readonly string[] {
  return [...updated ? ['--updated'] : [], `--user-data-dir=${userData}`]
}

function cleanEnvironment(home?: string): NodeJS.ProcessEnv {
  return localUpgradeHelperEnvironment(process.env, home)
}

interface CopyEntry { readonly path: string; readonly kind: 'directory' | 'file' | 'link'; readonly hash?: string; readonly target?: string }
async function plainAncestors(file: string): Promise<void> {
  for (let cursor = file; ; cursor = dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new LocalUpgradeError('linked-path') }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    if (dirname(cursor) === cursor) break
  }
}

async function snapshot(source: string, destination: string, allowLinks: boolean): Promise<readonly CopyEntry[]> {
  await plainAncestors(source)
  await plainAncestors(destination)
  await mkdir(destination)
  const inventory: CopyEntry[] = []
  const visit = async (relative: string): Promise<void> => {
    const from = join(source, relative)
    const to = join(destination, relative)
    const information = await lstat(from)
    if (information.isSymbolicLink()) {
      if (!allowLinks) throw new LocalUpgradeError('linked-installation')
      // Data backups record links without following them or making a link escape from the private backup.
      inventory.push({ path: relative, kind: 'link', target: await readlink(from) })
    } else if (information.isDirectory()) {
      if (relative !== '') { await mkdir(to); inventory.push({ path: relative, kind: 'directory' }) }
      for (const name of (await readdir(from)).sort()) await visit(join(relative, name))
    } else if (information.isFile()) {
      const hash = await localUpgradeHash(from)
      await copyFile(from, to, constants.COPYFILE_EXCL)
      if (await localUpgradeHash(to) !== hash || await localUpgradeHash(from) !== hash) throw new LocalUpgradeError('backup-source-changed')
      inventory.push({ path: relative, kind: 'file', hash })
    } else throw new LocalUpgradeError('unsupported-backup-entry')
  }
  await visit('')
  return inventory
}

async function treeBytes(root: string): Promise<bigint> {
  const entry = await lstat(root)
  if (entry.isSymbolicLink()) return 0n
  if (entry.isFile()) return BigInt(entry.size)
  if (!entry.isDirectory()) throw new LocalUpgradeError('unsupported-backup-entry')
  let bytes = 0n
  for (const name of await readdir(root)) bytes += await treeBytes(join(root, name))
  return bytes
}

async function dataUnchanged(source: string, inventoryFile: string): Promise<boolean> {
  const expected: unknown = JSON.parse(await readFile(inventoryFile, 'utf8'))
  if (!Array.isArray(expected)) throw new LocalUpgradeError('invalid-backup-inventory')
  const observed: CopyEntry[] = []
  const visit = async (relative: string): Promise<void> => {
    const file = join(source, relative)
    const information = await lstat(file)
    if (information.isSymbolicLink()) observed.push({ path: relative, kind: 'link', target: await readlink(file) })
    else if (information.isDirectory()) {
      if (relative !== '') observed.push({ path: relative, kind: 'directory' })
      for (const name of (await readdir(file)).sort()) await visit(join(relative, name))
    } else if (information.isFile()) observed.push({ path: relative, kind: 'file', hash: await localUpgradeHash(file) })
    else throw new LocalUpgradeError('unsupported-backup-entry')
  }
  await visit('')
  return JSON.stringify(observed) === JSON.stringify(expected)
}

/**
 * Parse native process observations before using them to select or stop a process.
 * @param value Successful native JSON.
 * @param executable Consented installed executable.
 * @returns Narrow process/window/listener observations.
 */
export function parseLocalUpgradeInspection(value: Record<string, unknown>, executable: string): LocalUpgradeInspection {
  if (!Array.isArray(value.processes) || !Array.isArray(value.roots) || !Array.isArray(value.hosts)
    || !Array.isArray(value.ports) || typeof value.responsive !== 'boolean') throw new LocalUpgradeError('invalid-inspection')
  const numbers = (items: unknown[]): number[] => items.map((item) => {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) throw new LocalUpgradeError('invalid-inspection')
    return item
  })
  const processes = value.processes.map((item: unknown): LocalUpgradeProcess => {
    if (typeof item !== 'object' || item === null || !('pid' in item) || typeof item.pid !== 'number' || !Number.isSafeInteger(item.pid) || item.pid <= 0
      || !('parent' in item) || typeof item.parent !== 'number' || !Number.isSafeInteger(item.parent) || item.parent < 0
      || !('created' in item) || typeof item.created !== 'string' || !/^\d{10,20}$/u.test(item.created)
      || !('executable' in item) || typeof item.executable !== 'string' || item.executable.toLowerCase() !== executable.toLowerCase()) throw new LocalUpgradeError('invalid-inspection')
    return { pid: item.pid, parent: item.parent, created: item.created, executable }
  })
  return { processes, roots: numbers(value.roots), hosts: numbers(value.hosts), ports: numbers(value.ports), responsive: value.responsive }
}

/**
 * Accept only the launched main process's nonsecret receipt, bound to this request and its live Host child.
 * @param input Parsed private receipt JSON; HTTP responses and additional credential fields are refused.
 * @param expected Fresh launch nonce and exact inspected application version.
 * @param live Native observations from the installed executable's process tree.
 * @returns Validated startup facts; stale, foreign, or malformed receipts never establish readiness.
 */
export function parseLocalUpgradeReadiness(
  input: unknown, expected: { readonly nonce: string; readonly version: string }, live: LocalUpgradeInspection,
): DesktopStartupReadiness {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.keys(input).some(key => !['schemaVersion', 'nonce', 'version', 'mainPid', 'hostPid'].includes(key))
    || !('schemaVersion' in input) || input.schemaVersion !== 1 || !('nonce' in input) || input.nonce !== expected.nonce
    || !('version' in input) || input.version !== expected.version
    || !('mainPid' in input) || typeof input.mainPid !== 'number' || !Number.isSafeInteger(input.mainPid) || input.mainPid <= 0
    || !('hostPid' in input) || typeof input.hostPid !== 'number' || !Number.isSafeInteger(input.hostPid) || input.hostPid <= 0
    || live.roots.length !== 1 || input.mainPid !== live.roots[0] || live.hosts.length !== 1 || input.hostPid !== live.hosts[0]
    || !live.processes.some(item => item.pid === input.mainPid) || !live.processes.some(item => item.pid === input.hostPid)) {
    throw new LocalUpgradeError('startup-readiness-receipt-differ')
  }
  return { schemaVersion: 1, nonce: expected.nonce, version: expected.version, mainPid: input.mainPid, hostPid: input.hostPid }
}

async function waitFor(test: () => Promise<boolean>, deadline: number): Promise<void> {
  while (!await test()) {
    if (Date.now() >= deadline) throw new LocalUpgradeError('deadline-exceeded')
    await delay(500)
  }
}

/**
 * Run the staged manifest once. The ready/armed handshake precedes the Session gate and every stop.
 * @param manifest Absolute immutable private worker plan.
 * @returns Resolves after recording success or failure; native cleanup and failure notification are bounded.
 */
export async function runLocalUpgradeWorker(manifest: string): Promise<void> {
  const plan = parseLocalUpgradePlan(JSON.parse(await readFile(manifest, 'utf8')))
  const { run, consent, artifact } = plan
  if (resolve(manifest).toLowerCase() !== join(run, 'plan.json').toLowerCase()) throw new LocalUpgradeError('unexpected-plan-path')
  const helper = join(run, 'native.ps1')
  const task = `DSHLocalUpgrade-${plan.id}`
  const native = (operation: string, input: object) => localUpgradeNative(helper, run, operation, input)
  const inspect = async () => parseLocalUpgradeInspection(await native('inspect', { executable: consent.executable }), consent.executable)
  const event = async (stage: string): Promise<void> => {
    await appendFile(join(run, 'events.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), stage })}\n`, { flush: true, mode: 0o600 })
  }
  const installRoot = dirname(consent.executable)
  const applicationAsar = join(installRoot, 'resources/app.asar')
  const backup = join(run, 'backup')
  const readinessFile = join(run, 'desktop-ready.json')
  const readinessNonce = randomUUID()
  const launchProduct = async (updated: boolean): Promise<void> => {
    const environment = localUpgradeProductEnvironment(process.env, consent)
    if (updated) {
      environment.DSH_DESKTOP_READY_RECEIPT = readinessFile
      environment.DSH_DESKTOP_READY_NONCE = readinessNonce
    }
    const child = spawn(consent.executable, [...localUpgradeProductArguments(consent.userData, updated)], {
      cwd: installRoot, detached: true, stdio: 'ignore', env: environment,
    })
    await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject) })
    child.unref()
  }
  const deadline = Date.now() + consent.deadlineMs
  let successorObserved = false
  let success = false
  let failureCode: string | undefined
  let taskCleanupFailed = false
  let installStartedAt = 0
  let installerUnsettled = false
  let installDispatched = false
  let requiredBytes: bigint | undefined
  let backupVerified = false
  try {
    const qualification: unknown = JSON.parse(await readFile(join(run, 'native-qualification.json'), 'utf8'))
    if (typeof qualification !== 'object' || qualification === null || !('passed' in qualification)
      || qualification.passed !== true || !('restartManagerFlags' in qualification)
      || qualification.restartManagerFlags !== 0) throw new LocalUpgradeError('native-qualification-required')
    const inventory: unknown = JSON.parse(await readFile(join(run, 'worker-inventory.json'), 'utf8'))
    if (!Array.isArray(inventory) || inventory.length !== 5) throw new LocalUpgradeError('invalid-worker-inventory')
    const names = new Set<string>()
    for (const entry of inventory) {
      if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string'
        || !['node.exe', 'local-upgrade.js', 'local-upgrade-worker.js', 'package.json', 'native.ps1'].includes(entry.path)
        || !('sha256' in entry) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || await localUpgradeHash(join(run, entry.path)) !== entry.sha256 || names.has(entry.path)) {
        throw new LocalUpgradeError('worker-bytes-changed')
      }
      names.add(entry.path)
    }
    const helperHash = await localUpgradeHash(helper)
    const planHash = await localUpgradeHash(manifest)
    const identity = await native('independent', { pid: process.pid, executable: process.execPath,
      forbidden: plan.processes.map(item => item.pid) })
    if (typeof identity.created !== 'string' || !/^\d{10,20}$/u.test(identity.created)) throw new LocalUpgradeError('worker-identity-unknown')
    await writeFile(join(run, 'ready.json'), JSON.stringify({ pid: process.pid, created: identity.created, independent: true }),
      { flag: 'wx', flush: true })
    await waitFor(async () => {
      try {
        const armed: unknown = JSON.parse(await readFile(join(run, 'armed.json'), 'utf8'))
        return typeof armed === 'object' && armed !== null && 'pid' in armed && armed.pid === process.pid
          && 'created' in armed && armed.created === identity.created
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
        throw error
      }
    }, Date.now() + 60_000)
    await executeLocalUpgrade({
      event,
      verify: async () => {
        if (await localUpgradeHash(helper) !== helperHash || await localUpgradeHash(manifest) !== planHash) {
          throw new LocalUpgradeError('worker-instructions-changed')
        }
        const fenced = await native('fence', { run, uninstallKey: consent.uninstallKey, executable: consent.executable,
          version: plan.previous.version, paths: [consent.executable, consent.home, consent.userData, artifact.installer, plan.gate.file] })
        requiredBytes ??= 2n * await treeBytes(installRoot) + await treeBytes(consent.home)
          + await treeBytes(consent.userData) + 512n * 1024n * 1024n
        if (typeof fenced.freeBytes !== 'string' || !/^\d+$/u.test(fenced.freeBytes)
          || BigInt(fenced.freeBytes) < requiredBytes) throw new LocalUpgradeError('insufficient-private-backup-space')
        if (await localUpgradeHash(artifact.installer) !== artifact.installerHash
          || await localUpgradeHash(consent.executable) !== plan.previous.executableHash
          || await localUpgradeHash(applicationAsar) !== plan.previous.asarHash) throw new LocalUpgradeError('staged-or-installed-bytes-changed')
        const current = await inspect()
        if (current.roots.length !== 1 || current.roots[0] !== plan.main.pid || current.hosts.length !== 1
          || !plan.processes.some(item => item.pid === current.hosts[0])) throw new LocalUpgradeError('application-owner-changed')
        for (const expected of [plan.main, ...plan.processes.filter(item => current.hosts.includes(item.pid))]) {
          if (!current.processes.some(item => item.pid === expected.pid && item.created === expected.created)) throw new LocalUpgradeError('process-identity-changed')
        }
      },
      waitForTurn: async () => {
        await waitFor(async () => {
          try { return localUpgradeTurnEnded(await readLocalUpgradeSession(plan.gate.file), plan.gate) }
          catch (error) {
            if (error instanceof LocalUpgradeError && ['session-read-raced', 'incomplete-session-tail'].includes(error.code)) return false
            throw error
          }
        }, deadline)
        await event('durable-turn-completed')
      },
      stop: async () => {
        // Re-read immediately before the native request; a later continuation cancels the handoff.
        if (!localUpgradeTurnEnded(await readLocalUpgradeSession(plan.gate.file), plan.gate)) throw new LocalUpgradeError('turn-not-ended')
        await native('stop', plan.main)
      },
      quiescent: async () => {
        await waitFor(async () => {
          const current = await inspect()
          const unexpected = current.processes.some(item => !plan.processes
            .some(expected => expected.pid === item.pid && expected.created === item.created))
          if (unexpected) {
            throw new LocalUpgradeError('unexpected-live-application')
          }
          return current.processes.length === 0
        }, Date.now() + 60_000)
        await event('application-tree-exited')
      },
      backup: async () => {
        const fenced = await native('fence', { run, uninstallKey: consent.uninstallKey, executable: consent.executable,
          version: plan.previous.version, paths: [consent.home, consent.userData, installRoot] })
        if (typeof fenced.freeBytes !== 'string' || !/^\d+$/u.test(fenced.freeBytes)) throw new LocalUpgradeError('disk-capacity-unknown')
        await mkdir(backup)
        for (const [name, source, links] of [['application', installRoot, false], ['home', consent.home, true], ['electron', consent.userData, true]] as const) {
          const inventory = await snapshot(source, join(backup, name), links)
          const record = join(backup, `${name}.inventory.json`)
          await writeFile(record, JSON.stringify(inventory), { flag: 'wx', flush: true })
          if (!await dataUnchanged(source, record)) throw new LocalUpgradeError('backup-source-changed')
        }
        await event('backup-verified')
        backupVerified = true
      },
      install: async () => {
        if ((await inspect()).processes.length !== 0 || await localUpgradeHash(artifact.installer) !== artifact.installerHash) throw new LocalUpgradeError('preinstall-state-changed')
        installStartedAt = Date.now()
        const child = spawn(artifact.installer, [...localUpgradeInstallerArguments(consent.executable)], {
          cwd: run, env: cleanEnvironment(consent.home), windowsHide: false, detached: true, stdio: 'ignore',
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await new Promise<void>((accept, reject) => {
            child.once('error', () => { installerUnsettled = false; reject(new LocalUpgradeError('installer-launch-failed')) })
            child.once('spawn', () => { installDispatched = true; installerUnsettled = true })
            child.once('exit', (code, signal) => {
              installerUnsettled = false
              if (code === 0 && signal === null) accept()
              else reject(new LocalUpgradeError('installer-failed'))
            })
            timer = setTimeout(() => {
              child.unref()
              // An installer with unknown outcome is never killed or raced by rollback.
              reject(new LocalUpgradeError('installer-outcome-unknown'))
            }, 30 * 60_000)
          })
        } finally { clearTimeout(timer) }
      },
      successorStarted: async () => {
        // Once any successor is observed, a later exit cannot make data rollback safe again.
        successorObserved ||= (await inspect()).processes
          .some(item => !plan.processes.some(old => old.pid === item.pid && old.created === item.created))
        if (installDispatched && !installerUnsettled && !successorObserved) {
          successorObserved = !await dataUnchanged(consent.home, join(backup, 'home.inventory.json'))
            || !await dataUnchanged(consent.userData, join(backup, 'electron.inventory.json'))
        }
        return successorObserved || installerUnsettled
      },
      health: async () => {
        if (await localUpgradeHash(consent.executable) !== artifact.executableHash
          || await localUpgradeHash(applicationAsar) !== artifact.asarHash) {
          throw new LocalUpgradeError('installed-bytes-differ')
        }
        await native('fence', { run, uninstallKey: consent.uninstallKey, executable: consent.executable,
          version: artifact.version, paths: [consent.executable, consent.home, consent.userData] })
        successorObserved ||= (await inspect()).processes.length > 0
        if (successorObserved || !await dataUnchanged(consent.home, join(backup, 'home.inventory.json'))
          || !await dataUnchanged(consent.userData, join(backup, 'electron.inventory.json'))) {
          throw new LocalUpgradeError('unexpected-successor-or-data-change')
        }
        try { await lstat(readinessFile); throw new LocalUpgradeError('startup-receipt-destination-exists') }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        await event('launch-trusted-product')
        await launchProduct(true)
        await waitFor(async () => {
          const current = await inspect()
          successorObserved ||= current.processes.length > 0
          if (!current.responsive || current.roots.length !== 1 || current.hosts.length !== 1) return false
          try {
            const value: unknown = JSON.parse(await readFile(readinessFile, 'utf8'))
            parseLocalUpgradeReadiness(value, { nonce: readinessNonce, version: artifact.version }, current)
            return true
          } catch (error) {
            if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return false
            throw error
          }
        }, Date.now() + 120_000)
        const cli = join(installRoot, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
        const { stdout } = await promisify(execFile)(consent.executable, ['--expose-internals', cli, '--version'], {
          cwd: run, env: { ...cleanEnvironment(consent.home), ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
        })
        if (stdout.trim() !== artifact.runtimeVersion || installStartedAt === 0) throw new LocalUpgradeError('installed-cli-version-differ')
        await event('responsive-window-authenticated-startup-receipt-and-cli-version-verified')
      },
      rollback: async () => {
        if ((await inspect()).processes.length !== 0 || successorObserved || installerUnsettled) throw new LocalUpgradeError('rollback-no-longer-safe')
        if (!installDispatched) return
        const old = join(backup, 'application')
        if (await localUpgradeHash(join(old, 'DeepSeek Harness.exe')) !== plan.previous.executableHash
          || await localUpgradeHash(join(old, 'resources/app.asar')) !== plan.previous.asarHash) throw new LocalUpgradeError('backup-identity-changed')
        const restored = `${installRoot}.restore-${plan.id}`
        const failed = `${installRoot}.failed-${plan.id}`
        await plainAncestors(restored)
        const inventory = await snapshot(old, restored, false)
        const expected: unknown = JSON.parse(await readFile(join(backup, 'application.inventory.json'), 'utf8'))
        if (JSON.stringify(inventory) !== JSON.stringify(expected)) throw new LocalUpgradeError('backup-inventory-changed')
        await plainAncestors(installRoot)
        await plainAncestors(failed)
        try { await lstat(failed); throw new LocalUpgradeError('rollback-destination-exists') }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        // Exact validated siblings are preserved, never deleted; neither operation touches either data root.
        await rename(installRoot, failed)
        try { await rename(restored, installRoot) }
        catch (error) { await rename(failed, installRoot); throw error }
        await native('restore-registration', { uninstallKey: consent.uninstallKey, executable: consent.executable,
          version: plan.previous.version, successorVersion: artifact.version })
        await event('previous-application-restored-user-data-untouched')
      },
      relaunchPrevious: async () => {
        if ((await inspect()).processes.length !== 0) throw new LocalUpgradeError('relaunch-owner-changed')
        await launchProduct(false)
      },
    })
    success = true
  } catch (error) {
    failureCode = error instanceof LocalUpgradeError ? error.code : 'unexpected-operation-failed'
  } finally {
    try { await native('unregister', { task }) }
    catch (_error) { taskCleanupFailed = true }
    await writeFile(join(run, 'result.json'), JSON.stringify({ success, failureCode, taskCleanupFailed,
      successorObserved, installerUnsettled, backupVerified, backupsRetained: true, userDataRestored: false,
      completedAt: new Date().toISOString() }), { flag: 'wx', flush: true })
    if (!installerUnsettled) {
      const active = JSON.parse(await readFile(join(consent.workRoot, 'active.json'), 'utf8')) as { id?: string; run?: string }
      if (active.id !== plan.id || active.run !== run) throw new LocalUpgradeError('active-owner-changed')
      await rm(join(consent.workRoot, 'active.json'))
    }
    try { await native('notify', { run, success }) }
    catch (_error) { console.error('Local Desktop upgrade finished; inspect the private run result.') }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const manifest = process.argv[2]
  if (manifest === undefined || process.argv.length !== 3) process.exitCode = 2
  else void runLocalUpgradeWorker(manifest).catch(() => { console.error('Local Desktop upgrade could not load its private plan.'); process.exitCode = 1 })
}
