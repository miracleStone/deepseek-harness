#!/usr/bin/env node
/** Build/stage one explicitly consented personal unsigned upgrade; the external task waits for the current durable turn. */
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import { gt } from 'semver'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { validateInstalledUpdateArchivePaths } from './verify-installed-update-package.ts'
import {
  captureLocalUpgradeTurn, LocalUpgradeError, parseLocalUpgradeConsent, parseLocalUpgradePlan,
  type LocalUpgradeConsent, type LocalUpgradePlan,
} from './local-upgrade.ts'
import { localUpgradeHash, localUpgradeNative, parseLocalUpgradeInspection, readLocalUpgradeSession } from './local-upgrade-worker.ts'

const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LocalUpgradeError('invalid-json')
  return value as Record<string, unknown>
}
async function json(file: string): Promise<Record<string, unknown>> { return object(JSON.parse(await readFile(file, 'utf8'))) }

/**
 * Choose a never-published local test suffix using only retained local artifact/run versions.
 * @param base Product version declared by this checkout.
 * @param taken Versions already reserved or packaged locally.
 * @param now Calendar sample, replaceable in deterministic tests.
 * @returns Next Asia/Shanghai date/index version; never queries a bucket or grants release publication consent.
 */
export function nextLocalUpgradeVersion(base: string, taken: readonly string[], now: Date): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => part.value).join('')
  const prefix = `${desktopBuildVersionPrefix(base)}${date}.`
  const used = taken.filter(version => version.startsWith(prefix))
    .map(version => Number(version.slice(prefix.length))).filter(Number.isSafeInteger)
  return validateDesktopBuildVersion(`${prefix}${Math.max(0, ...used) + 1}`, base)
}

async function runPnpm(args: readonly string[]): Promise<void> {
  let invocation: ReturnType<typeof pnpmInvocation>
  try { invocation = pnpmInvocation(args) }
  catch { throw new LocalUpgradeError('invoke-through-pnpm') }
  await new Promise<void>((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: repository, stdio: 'inherit', env: process.env })
    child.once('error', () => { reject(new LocalUpgradeError('packaging-launch-failed')) })
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) accept()
      else reject(new LocalUpgradeError('official-packaging-failed'))
    })
  })
}

async function currentSession(home: string, sessionId: string) {
  if (!/^session-[a-z0-9-]+$/u.test(sessionId)) throw new LocalUpgradeError('invalid-session-id')
  const candidates: string[] = []
  const root = join(home, 'sessions')
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const directory = join(root, project.name, sessionId)
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new LocalUpgradeError('linked-session')
      const generations = (await readdir(directory)).flatMap((name) => {
        const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/u.exec(name)
        return match === null ? [] : [{ name, version: Number(match[1] ?? 0) }]
      }).sort((left, right) => right.version - left.version)
      if (generations[0] !== undefined) candidates.push(join(directory, generations[0].name))
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  if (candidates.length !== 1) throw new LocalUpgradeError('session-not-unique')
  const file = candidates[0]!
  return captureLocalUpgradeTurn(await readLocalUpgradeSession(file), sessionId, file)
}

async function packageIdentity(installRoot: string, consent: LocalUpgradeConsent, version?: string) {
  const metadata = object(await (await readAsar(join(installRoot, 'resources/app.asar'))).readJson('package.json'))
  if (metadata.name !== consent.packageName || metadata.dshDesktopAppId !== consent.appId || metadata.main !== 'lib/main.js'
    || typeof metadata.version !== 'string' || (version !== undefined && metadata.version !== version)) throw new LocalUpgradeError('application-identity-differ')
  return { version: metadata.version,
    executableHash: await localUpgradeHash(join(installRoot, 'DeepSeek Harness.exe')),
    asarHash: await localUpgradeHash(join(installRoot, 'resources/app.asar')) }
}

async function extractInstaller(installer: string, run: string): Promise<string> {
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const { getPath7za } = builderRequire('app-builder-lib/out/toolsets/7zip.js') as { getPath7za(): Promise<string> }
  const tool = await getPath7za()
  const toolHash = await localUpgradeHash(tool)
  const extract = async (archive: string, destination: string): Promise<void> => {
    const execute = (args: string[]) => promisify(execFile)(tool, args, { windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    validateInstalledUpdateArchivePaths((await execute(['l', '-slt', '-ba', '-sccUTF-8', '--', archive])).stdout)
    await mkdir(destination)
    await execute(['x', '-y', '-bd', '-bso0', '-bsp0', `-o${destination}`, '--', archive])
  }
  const outer = join(run, 'extracted')
  await extract(installer, outer)
  let payload = outer
  try { await lstat(join(payload, 'resources/app.asar')) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const archives: string[] = []
    const visit = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new LocalUpgradeError('linked-archive-entry')
        const file = join(directory, item.name)
        if (item.isDirectory()) await visit(file)
        else if (/^app-64\.7z$/u.test(item.name)) archives.push(file)
      }
    }
    await visit(outer)
    if (archives.length !== 1) throw new LocalUpgradeError('installer-payload-not-unique')
    payload = join(run, 'payload')
    await extract(archives[0]!, payload)
  }
  if (await localUpgradeHash(tool) !== toolHash) throw new LocalUpgradeError('archive-tool-changed')
  return payload
}

/**
 * Emit one staged worker module with only local JavaScript and Node builtin imports.
 * @param name One of the two owned worker modules.
 * @param source Current TypeScript source, copied before the live installation can stop.
 * @returns Native ESM JavaScript; no tsx, compiler, repository, or live-app dependency remains.
 */
export function compileLocalUpgradeWorker(name: 'local-upgrade' | 'local-upgrade-worker', source: string): string {
  const compiled = ts.transpileModule(source, { fileName: `${name}.ts`, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } })
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new LocalUpgradeError('worker-compilation-failed')
  return compiled.outputText
}

async function stageWorker(run: string): Promise<void> {
  await copyFile(process.execPath, join(run, 'node.exe'), constants.COPYFILE_EXCL)
  for (const name of ['local-upgrade', 'local-upgrade-worker'] as const) {
    const source = await readFile(join(import.meta.dirname, `${name}.ts`), 'utf8')
    await writeFile(join(run, `${name}.js`), compileLocalUpgradeWorker(name, source), { flag: 'wx', flush: true })
  }
  await writeFile(join(run, 'package.json'), '{"type":"module","private":true}\n', { flag: 'wx', flush: true })
  await copyFile(join(import.meta.dirname, 'local-upgrade-windows.ps1'), join(run, 'native.ps1'), constants.COPYFILE_EXCL)
  const files = ['node.exe', 'local-upgrade.js', 'local-upgrade-worker.js', 'package.json', 'native.ps1']
  await writeFile(join(run, 'worker-inventory.json'), JSON.stringify(await Promise.all(files.map(async path => ({ path, sha256: await localUpgradeHash(join(run, path)) })))), { flag: 'wx', flush: true })
}

async function qualifyShutdown(run: string, native: (operation: string, input: object) => Promise<Record<string, unknown>>): Promise<void> {
  const directory = join(run, 'native-qualification')
  await mkdir(join(directory, 'electron-data'), { recursive: true })
  const electron: unknown = require('electron')
  if (typeof electron !== 'string') throw new LocalUpgradeError('qualification-electron-missing')
  const child = spawn(electron, [join(repository, 'apps/desktop/tests/fixtures/local-upgrade-graceful.mjs'), directory], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: false,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_|^DSH_/iu.test(name))),
  })
  const exited = new Promise<void>((accept, reject) => {
    child.once('error', () => { reject(new LocalUpgradeError('native-qualification-launch-failed')) })
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) accept()
      else reject(new LocalUpgradeError('native-qualification-exit-failed'))
    })
  })
  void exited.catch(() => undefined)
  let exitConfirmed = false
  try {
    const readyDeadline = Date.now() + 30_000
    let ready: Record<string, unknown> | undefined
    while (ready === undefined) {
      try { ready = await json(join(directory, 'ready.json')) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      if (Date.now() >= readyDeadline || child.exitCode !== null) throw new LocalUpgradeError('native-qualification-not-ready')
      if (ready === undefined) await delay(100)
    }
    const observed = parseLocalUpgradeInspection(await native('inspect', { executable: electron }), electron)
    const process = observed.processes.find(item => item.pid === child.pid)
    if (process === undefined || ready.pid !== child.pid) throw new LocalUpgradeError('native-qualification-identity-differ')
    await native('stop', process)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited, new Promise<never>((_accept, reject) => {
        timer = setTimeout(() => { reject(new LocalUpgradeError('native-qualification-shutdown-refused')) }, 30_000)
      })])
      exitConfirmed = true
    } finally { clearTimeout(timer) }
    if ((await json(join(directory, 'session-end.json'))).sessionEnd !== true) throw new LocalUpgradeError('native-qualification-no-session-end')
    await writeFile(join(run, 'native-qualification.json'), JSON.stringify({ passed: true, restartManagerFlags: 0,
      fixtureOnly: true, installedApplicationShutdown: 'not-yet-attempted' }), { flag: 'wx', flush: true })
  } finally {
    if (!exitConfirmed && child.connected) {
      // This owned fixture has a private graceful exit channel; it never targets the installed or development app.
      child.send({ type: 'qualification-finish' })
      await exited
    }
  }
}

async function successfulPackageRun(parent: string, version: string): Promise<string> {
  for (const item of (await readdir(parent, { withFileTypes: true })).sort((left, right) => right.name.localeCompare(left.name))) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue
    const directory = join(parent, item.name)
    try {
      const metadata = await json(join(directory, 'run.json'))
      const result = await json(join(directory, 'result.json'))
      if (metadata.target === 'win-x64' && metadata.unsigned === true && metadata.prepareOnly === false
        && metadata.directory === false && metadata.version === version && result.success === true) return directory
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  throw new LocalUpgradeError('official-packaging-record-missing')
}

/**
 * Stage or check a local upgrade from explicit machine consent. No stage can stop the running application.
 * @param argv CLI arguments after this entry point.
 * @returns Public, credential-free stage/status observations.
 */
export async function upgradeWindowsLocal(argv: readonly string[]): Promise<object> {
  const { values } = parseArgs({ args: [...argv], options: {
    config: { type: 'string' }, execute: { type: 'boolean' }, check: { type: 'boolean' },
    'build-version': { type: 'string' }, 'prepared-run': { type: 'string' }, 'session-id': { type: 'string' }, status: { type: 'string' },
  } })
  if (values.status !== undefined) {
    const run = resolve(values.status)
    const plan = parseLocalUpgradePlan(await json(join(run, 'plan.json')))
    if (run.toLowerCase() !== plan.run.toLowerCase()) throw new LocalUpgradeError('unexpected-plan-path')
    try { return { run, result: await json(join(run, 'result.json')) } }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { run, outcome: 'pending', events: await readFile(join(run, 'events.jsonl'), 'utf8') }
      throw error
    }
  }
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) throw new LocalUpgradeError('requires-windows-x64-node24')
  if (values.config === undefined || (values.execute && values.check)) throw new LocalUpgradeError('supply-machine-config-and-one-mode')
  const consentFile = resolve(values.config)
  const consent = parseLocalUpgradeConsent(await json(consentFile))
  if (repository.toLowerCase() !== consent.repository.toLowerCase()) throw new LocalUpgradeError('checkout-not-consented')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-local-upgrade-'))
  const id = randomUUID()
  const run = join(consent.workRoot, id)
  let activeOwned = false
  let armed = false
  let taskRegistered = false
  let prepared = false
  const native = (operation: string, input: object) => localUpgradeNative(join(import.meta.dirname, 'local-upgrade-windows.ps1'), temporary, operation, input)
  try {
    await native('prepare', { consentFile, workRoot: consent.workRoot, run,
      uninstallKey: consent.uninstallKey, executable: consent.executable,
      paths: [consent.repository, consent.executable, consent.home, consent.userData, consent.workRoot] })
    prepared = true
    console.info(`LOCAL_DESKTOP_UPGRADE_RUN ${run}`)
    const observation = parseLocalUpgradeInspection(await native('inspect', { executable: consent.executable }), consent.executable)
    if (observation.roots.length !== 1 || observation.hosts.length !== 1) throw new LocalUpgradeError('one-live-desktop-required')
    const main = observation.processes.find(item => item.pid === observation.roots[0])!
    const previous = await packageIdentity(dirname(consent.executable), consent)
    if (!values.execute) return { checked: true, run, appVersion: previous.version,
      nativeShutdownQualified: false, applicationStopped: false,
      next: 'Execution first qualifies Restart Manager with a disposable Electron fixture, then arms an external worker that waits for the captured durable turn.' }
    const sessionId = values['session-id'] ?? process.env.DSH_SESSION_ID
    if (sessionId === undefined) throw new LocalUpgradeError('current-session-id-required')
    const gate = await currentSession(consent.home, sessionId)
    const lock = await open(join(consent.workRoot, 'active.json'), 'wx', 0o600)
    try { await lock.writeFile(JSON.stringify({ id, run })); await lock.sync() } finally { await lock.close() }
    activeOwned = true
    const base = await json(join(repository, 'package.json'))
    if (typeof base.version !== 'string') throw new LocalUpgradeError('product-version-missing')
    let version = values['build-version']
    const artifacts = join(repository, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts')
    if (version === undefined) {
      if (!consent.allowAutomaticLocalVersions) throw new LocalUpgradeError('explicit-version-required')
      const taken: string[] = [previous.version]
      for (const item of await readdir(consent.workRoot, { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || !/^[a-f0-9-]{36}$/u.test(item.name)) continue
        try {
          const reservation = await json(join(consent.workRoot, item.name, 'reservation.json'))
          if (typeof reservation.version !== 'string') throw new LocalUpgradeError('invalid-version-reservation')
          taken.push(reservation.version)
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
      try {
        for (const name of await readdir(artifacts)) {
          const match = /^deepseek-harness-(.+)-win-x64-unsigned\.exe$/u.exec(name)
          if (match !== null) taken.push(match[1]!)
        }
      }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      version = nextLocalUpgradeVersion(base.version, taken, new Date())
    }
    validateDesktopBuildVersion(version, base.version)
    if (!gt(version, previous.version)) throw new LocalUpgradeError('local-version-must-increase')
    await writeFile(join(run, 'reservation.json'), JSON.stringify({ version, personalUnsignedOnly: true }), { flag: 'wx', flush: true })
    if (values['prepared-run'] === undefined) await runPnpm(['run', 'package:desktop:win:x64:unsigned', '--build-version', version])
    const record = values['prepared-run'] === undefined
      ? await successfulPackageRun(join(repository, 'apps/desktop/.desktop-build/packaging-runs'), version)
      : resolve(values['prepared-run'])
    if (await successfulPackageRun(dirname(record), version) !== record) throw new LocalUpgradeError('prepared-run-not-latest-success')
    const installer = join(run, 'installer.exe')
    const source = join(artifacts, `deepseek-harness-${version}-win-x64-unsigned.exe`)
    const installerHash = await localUpgradeHash(source)
    await copyFile(source, installer, constants.COPYFILE_EXCL)
    if (await localUpgradeHash(installer) !== installerHash) throw new LocalUpgradeError('installer-copy-differ')
    const payload = await extractInstaller(installer, run)
    const installed = await packageIdentity(payload, consent, version)
    try { await lstat(join(payload, 'resources/app-update.yml')); throw new LocalUpgradeError('unsigned-payload-has-release-updater') }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const plan: LocalUpgradePlan = parseLocalUpgradePlan({ schemaVersion: 1, id, consent, run,
      main, processes: observation.processes, gate, previous,
      artifact: { ...installed, runtimeVersion: base.version, installer, installerHash } })
    await stageWorker(run)
    await qualifyShutdown(run, native)
    await writeFile(join(run, 'plan.json'), JSON.stringify(plan), { flag: 'wx', flush: true })
    await writeFile(join(run, 'events.jsonl'), '', { flag: 'wx', flush: true })
    const task = `DSHLocalUpgrade-${id}`
    await native('register', { task, run, node: join(run, 'node.exe'), worker: join(run, 'local-upgrade-worker.js'), plan: join(run, 'plan.json') })
    taskRegistered = true
    const deadline = Date.now() + 60_000
    let ready: Record<string, unknown> | undefined
    while (ready === undefined) {
      try { ready = await json(join(run, 'ready.json')) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      if (Date.now() >= deadline) throw new LocalUpgradeError('external-worker-not-ready')
      if (ready === undefined) await delay(250)
    }
    if (ready.independent !== true || typeof ready.pid !== 'number' || !Number.isSafeInteger(ready.pid) || ready.pid <= 0
      || typeof ready.created !== 'string' || !/^\d{10,20}$/u.test(ready.created)) throw new LocalUpgradeError('invalid-worker-ready')
    await native('independent', { pid: ready.pid, created: ready.created, executable: join(run, 'node.exe'),
      forbidden: observation.processes.map(item => item.pid) })
    await writeFile(join(run, 'armed.json'), JSON.stringify({ pid: ready.pid, created: ready.created }), { flag: 'wx', flush: true })
    armed = true
    return { run, version, workerPid: ready.pid, armed: true, installed: false, waitingForDurableTurn: gate.turn,
      interruption: 'After the successful current turn is saved, the external worker will gracefully stop this Desktop and install. Reopen this session after restart; status/result remains in this private run.' }
  } catch (error) {
    if (prepared) {
      await writeFile(join(run, 'stage-result.json'), JSON.stringify({ success: false, applicationStopped: false,
        failureCode: error instanceof LocalUpgradeError ? error.code : 'stage-operation-failed' }), { flag: 'wx', flush: true })
    }
    throw error
  } finally {
    if (!armed && taskRegistered) await native('unregister', { task: `DSHLocalUpgrade-${id}` })
    if (!armed && activeOwned) {
      const lock = await json(join(consent.workRoot, 'active.json'))
      if (lock.id !== id || lock.run !== run) throw new LocalUpgradeError('active-owner-changed')
      await rm(join(consent.workRoot, 'active.json'))
    }
    // This exact random temporary directory was allocated by this invocation; never remove any consented root.
    if (dirname(temporary) !== tmpdir() || !basename(temporary).startsWith('dsh-local-upgrade-')) throw new LocalUpgradeError('temporary-owner-changed')
    await rm(temporary, { recursive: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  void upgradeWindowsLocal(process.argv.slice(2)).then((result) => { console.log(JSON.stringify(result, null, 2)) })
    .catch((error: unknown) => {
      console.error(error instanceof LocalUpgradeError ? error.message : 'local Desktop upgrade: operation failed; inspect the private stage record; no forced shutdown was requested')
      process.exitCode = 1
    })
}
