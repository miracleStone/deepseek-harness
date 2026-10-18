/** Local-only installer planning, exact-turn gating, and failure ownership without touching an installed app. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import {
  captureLocalUpgradeTurn, executeLocalUpgrade, localUpgradeInstallerArguments, localUpgradePath, localUpgradeTurnEnded,
  localUpgradeWithin, parseLocalUpgradeConsent, parseLocalUpgradePlan,
  type LocalUpgradeConsent, type LocalUpgradeOperations, type LocalUpgradePlan,
} from '../scripts/local-upgrade.ts'
import { compileLocalUpgradeWorker, nextLocalUpgradeVersion } from '../scripts/upgrade-windows-local.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  localUpgradeHash, localUpgradeHelperEnvironment, localUpgradeProductArguments, localUpgradeProductEnvironment,
  parseLocalUpgradeInspection, parseLocalUpgradeReadiness, readLocalUpgradeSession,
} from '../scripts/local-upgrade-worker.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-upgrade-test-'))
  directories.push(directory)
  return directory
}
const consent: LocalUpgradeConsent = {
  schemaVersion: 1, mode: 'personal-unsigned', repository: 'F:\\source\\harness', executable: 'D:\\Harness\\DeepSeek Harness.exe',
  home: 'C:\\Users\\Alice\\.dsh', userData: 'C:\\Users\\Alice\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop',
  workRoot: 'D:\\Harness-local-upgrades', appId: 'com.deepseek.harness', packageName: '@deepseek-ai/dsh-desktop',
  uninstallKey: '11111111-2222-4333-8444-555555555555',
  allowAutomaticLocalVersions: true, allowTaskInterruption: true, deadlineMs: 3_600_000,
}
const sessionId = 'session-11111111-1111-4111-8111-111111111111'
const file = `${consent.home}\\sessions\\project\\${sessionId}\\session.v4.jsonl.zstd`
const id = '22222222-2222-4222-8222-222222222222'
const hash = 'a'.repeat(64)
const main = { pid: 42, created: '134001234567890000', executable: consent.executable, parent: 1 }
const host = { ...main, pid: 43, parent: 42 }
const plan: LocalUpgradePlan = {
  schemaVersion: 1, id, consent, run: `${consent.workRoot}\\${id}`, main, processes: [main, host],
  previous: { version: '0.2.1-alpha.4.20261016.1', executableHash: hash, asarHash: hash },
  artifact: { version: '0.2.1-alpha.4.20261017.1', runtimeVersion: '0.2.1-alpha.4', installer: `${consent.workRoot}\\${id}\\installer.exe`,
    installerHash: hash, executableHash: hash, asarHash: hash },
  gate: { file, sessionId, version: 4, turn: 7, startSeq: 0 },
}
function log(...events: object[]): string {
  return [JSON.stringify({ type: 'session', version: 4, id: sessionId }), ...events.map((event, seq) => JSON.stringify({ seq, time: 1, ...event }))].join('\n') + '\n'
}
const start = { type: 'turn/start', data: { turn: 7 } }
const end = { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }
function operations() {
  const events: string[] = []
  const own = (name: string) => vi.fn(async () => { events.push(name) })
  const value: LocalUpgradeOperations = {
    event: async (stage) => { events.push(`event:${stage}`) }, verify: own('verify'), waitForTurn: own('gate'), stop: own('stop'),
    quiescent: own('exited'), backup: own('backup'), install: own('install'), successorStarted: vi.fn(async () => false),
    health: own('health'), rollback: own('rollback'), relaunchPrevious: own('relaunch'),
  }
  return { value, events }
}

describe('local upgrade planning', () => {
  it('requires a fresh private startup receipt with exact version and both live process identities, never an HTTP 401', () => {
    const expected = { nonce: id, version: plan.artifact.version }
    const live = { processes: [main, host], roots: [main.pid], hosts: [host.pid], ports: [], responsive: true }
    const receipt = { schemaVersion: 1, ...expected, mainPid: main.pid, hostPid: host.pid }
    expect(parseLocalUpgradeReadiness(receipt, expected, live)).toEqual(receipt)
    for (const value of [
      { status: 401 }, {}, { ...receipt, nonce: 'stale' }, { ...receipt, version: plan.previous.version },
      { ...receipt, mainPid: 1234 }, { ...receipt, hostPid: 5678 }, { ...receipt, token: 'not-accepted' },
    ]) expect(() => parseLocalUpgradeReadiness(value, expected, live)).toThrow('startup-readiness-receipt-differ')
    expect(() => parseLocalUpgradeReadiness(receipt, expected, { ...live, hosts: [999] })).toThrow()
    expect(() => parseLocalUpgradeReadiness(receipt, expected, { ...live, processes: [main] })).toThrow()
  })

  it('retains fresh provider credentials only in trusted product memory and pins custom browser storage', () => {
    const environment = Object.freeze({ PATH: 'tools', DEEPSEEK_API_KEY: 'test-provider-key', ANTHROPIC_AUTH_TOKEN: 'test-provider-token',
      DSH_HOME: 'C:\\other-home', DSH_DESKTOP_USER_DATA_DIR: 'C:\\other-browser', DSH_SESSION_ID: 'old-tool-session',
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require old-router', NODE_PATH: 'old-modules', npm_execpath: 'old-pnpm' })
    const paths = { home: consent.home, userData: 'D:\\custom browser data' }
    const product = localUpgradeProductEnvironment(environment, paths)
    expect(product).toEqual({ PATH: 'tools', DEEPSEEK_API_KEY: 'test-provider-key', ANTHROPIC_AUTH_TOKEN: 'test-provider-token',
      DSH_HOME: consent.home, DSH_DESKTOP_USER_DATA_DIR: paths.userData })
    expect(localUpgradeHelperEnvironment(environment)).toEqual({ PATH: 'tools', npm_execpath: 'old-pnpm' })
    expect(localUpgradeHelperEnvironment(environment, consent.home))
      .toEqual({ PATH: 'tools', npm_execpath: 'old-pnpm', DSH_HOME: consent.home })
    expect(localUpgradeProductArguments(paths.userData, true)).toEqual(['--updated', '--user-data-dir=D:\\custom browser data'])
    expect(localUpgradeProductArguments(paths.userData, false)).toEqual(['--user-data-dir=D:\\custom browser data'])
    expect(environment.DEEPSEEK_API_KEY).toBe('test-provider-key')
    expect(environment.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(environment.DSH_HOME).toBe('C:\\other-home')
  })

  it('loads emitted worker JavaScript under plain Node without repository dependencies or executing native operations', async () => {
    const root = await temporary()
    for (const name of ['local-upgrade', 'local-upgrade-worker'] as const) {
      const source = await readFile(join(import.meta.dirname, '../scripts', `${name}.ts`), 'utf8')
      const compiled = compileLocalUpgradeWorker(name, source)
      expect(compiled).not.toContain("from './local-upgrade.ts'")
      await writeFile(join(root, `${name}.js`), compiled)
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(join(root, 'local-upgrade-worker.js')).href)});console.log('self-contained-worker-imported')`],
    { cwd: root, timeout: 20_000 })
    expect(stdout.trim()).toBe('self-contained-worker-imported')
  })

  it('uses only native non-forced shutdown and current-user least-privilege external tasks', async () => {
    const helper = await readFile(join(import.meta.dirname, '../scripts/local-upgrade-windows.ps1'), 'utf8')
    expect(helper).toContain('RmShutdown(session, 0, IntPtr.Zero)')
    expect(helper).not.toMatch(/TerminateProcess|Stop-Process|\.Kill\(/u)
    expect(helper).toContain('$definition.Principal.LogonType = 3')
    expect(helper).toContain('$definition.Principal.RunLevel = 0')
    expect(helper).toContain('registered-target-differ')
  })

  it('requires explicit personal unsigned consent and separate canonical roots', () => {
    expect(parseLocalUpgradeConsent(consent)).toEqual(consent)
    for (const input of [
      { ...consent, mode: 'release' }, { ...consent, allowTaskInterruption: false }, { ...consent, typo: true },
      { ...consent, workRoot: 'D:\\Harness\\backup' }, { ...consent, home: 'D:\\Harness' },
      { ...consent, deadlineMs: 500 }, { ...consent, packageName: 'different-app' },
    ]) expect(() => parseLocalUpgradeConsent(input)).toThrow()
  })
  it.each(['C:\\', 'C:\\data\\..\\home', 'C:\\data\\', 'C:\\data\\NUL', 'C:\\data\\name.', 'C:\\data\\file:stream',
    '\\\\server\\share', '\\\\?\\C:\\data', 'relative', 'C:/data', 'C:\\data\\a"b'])('rejects unsafe target %s', (path) => {
    expect(() => localUpgradePath(path)).toThrow()
  })
  it('does not confuse neighboring directory prefixes or Windows case', () => {
    expect(localUpgradeWithin('D:\\Harness', 'd:\\harness\\resources')).toBe(true)
    expect(localUpgradeWithin('D:\\Harness', 'D:\\Harness-backup')).toBe(false)
    expect(localUpgradeWithin('D:\\Harness', 'C:\\Harness')).toBe(false)
  })
  it('revalidates private worker plans and rejects altered installers, process identities, and gate paths', () => {
    expect(parseLocalUpgradePlan(plan)).toEqual(plan)
    for (const input of [
      { ...plan, run: 'D:\\elsewhere' }, { ...plan, artifact: { ...plan.artifact, installer: 'D:\\other.exe' } },
      { ...plan, artifact: { ...plan.artifact, installerHash: '' } },
      { ...plan, main: { ...main, executable: 'D:\\Other\\DeepSeek Harness.exe' } },
      { ...plan, processes: [main, main] }, { ...plan, processes: [host] },
      { ...plan, gate: { ...plan.gate, file: 'D:\\outside\\session.v4.jsonl' } },
      { ...plan, gate: { ...plan.gate, version: 5 } },
      { ...plan, gate: { ...plan.gate, file: file.replace('session.v4', 'session.v3') } },
    ]) expect(() => parseLocalUpgradePlan(input)).toThrow()
  })
  it('keeps the official NSIS update and data-retention flags, with the directory last', () => {
    expect(localUpgradeInstallerArguments(consent.executable)).toEqual([
      '--updated', '/KEEP_APP_DATA', '/S', '/D=D:\\Harness',
    ])
  })
  it('numbers only local personal versions on the Asia/Shanghai date and retains the complete base', () => {
    expect(nextLocalUpgradeVersion('0.2.1-alpha.4', ['0.2.1-alpha.4.20261017.1', '0.2.1-alpha.4.20261017.4'], new Date('2026-10-16T16:00:00Z')))
      .toBe('0.2.1-alpha.4.20261017.5')
    expect(nextLocalUpgradeVersion('1.0.0', [], new Date('2026-10-16T15:59:59Z'))).toBe('1.0.0-test.20261016.1')
  })
  it('rejects invalid native process observations before selecting a PID', () => {
    const native = { processes: [main, host], roots: [42], hosts: [43], ports: [3080], responsive: true }
    expect(parseLocalUpgradeInspection(native, consent.executable)).toEqual(native)
    expect(() => parseLocalUpgradeInspection({ ...native, processes: [{ ...main, created: 'yesterday' }] }, consent.executable)).toThrow()
    expect(() => parseLocalUpgradeInspection({ ...native, ports: ['3080'] }, consent.executable)).toThrow()
  })
})

describe('exact durable turn gate', () => {
  it('waits for the real successful captured turn, not an existing previous end or an idle file', () => {
    const gate = captureLocalUpgradeTurn(log(start), sessionId, file)
    expect(localUpgradeTurnEnded(log(start), gate)).toBe(false)
    expect(localUpgradeTurnEnded(log(start, end), gate)).toBe(true)
    expect(() => captureLocalUpgradeTurn(log(start, end), sessionId, file)).toThrow('no-open-turn')
    expect(() => localUpgradeTurnEnded(log({ ...start, data: { turn: 8 } }, end), gate)).toThrow('session-turn-changed')
  })
  it.each(['aborted', 'error', 'blocked', 'interrupted'])('never shuts down after a %s turn', (kind) => {
    expect(() => localUpgradeTurnEnded(log(start, { ...end, data: { turn: 7, reason: { kind } } }), plan.gate)).toThrow('turn-not-completed')
  })
  it('refuses a later automatic continuation and mismatched or partial Session records', () => {
    expect(() => localUpgradeTurnEnded(log(start, end, { ...start, data: { turn: 8 } }), plan.gate)).toThrow('next-turn-started')
    expect(() => localUpgradeTurnEnded(log(start, end).trimEnd(), plan.gate)).toThrow('incomplete-session-tail')
    expect(() => localUpgradeTurnEnded(log(start, end).replace('"version":4', '"version":5'), plan.gate)).toThrow('unsupported-session')
    expect(() => localUpgradeTurnEnded(log(start, end).replace('"seq":1', '"seq":2'), plan.gate)).toThrow('invalid-session-sequence')
    expect(() => localUpgradeTurnEnded(log(start, end).replace(sessionId, 'session-other'), plan.gate)).toThrow('unsupported-session')
  })
  it.each([false, true])('reads stable complete physical storage without writing it (zstd=%s)', async (compressed) => {
    const root = await temporary()
    const target = join(root, `session.v4.jsonl${compressed ? '.zstd' : ''}`)
    const text = log(start, end)
    const split = text.indexOf('\n') + 1
    const bytes = compressed ? Buffer.concat([
      zstdCompressSync(Buffer.from(text.slice(0, split))), zstdCompressSync(Buffer.from(text.slice(split))),
    ]) : Buffer.from(text)
    await writeFile(target, bytes)
    const hash = await localUpgradeHash(target)
    expect(await readLocalUpgradeSession(target)).toBe(log(start, end))
    expect(await localUpgradeHash(target)).toBe(hash)
    await writeFile(join(root, 'session.v5.jsonl'), log(start, end))
    await expect(readLocalUpgradeSession(target)).rejects.toThrow('session-generation-changed')
    expect(await readFile(target)).toEqual(bytes)
  })
})

describe('external transaction ownership', () => {
  it('keeps shutdown, backup, and installation behind the durable turn barrier and exact process revalidation', async () => {
    const f = operations()
    const admitted = Promise.withResolvers<undefined>()
    const completed = Promise.withResolvers<undefined>()
    f.value.waitForTurn = async () => { admitted.resolve(undefined); await completed.promise }
    const run = executeLocalUpgrade(f.value)
    await admitted.promise
    expect(f.value.stop).not.toHaveBeenCalled()
    expect(f.value.backup).not.toHaveBeenCalled()
    expect(f.value.install).not.toHaveBeenCalled()
    completed.resolve(undefined)
    await run
    expect(f.events.filter(item => !item.startsWith('event:'))).toEqual(['verify', 'verify', 'stop', 'exited', 'backup', 'install', 'health'])
    expect(f.value.rollback).not.toHaveBeenCalled()
  })
  it('aborts without stopping anything when the captured turn fails or process validation changes after waiting', async () => {
    for (const stage of ['gate', 'revalidation']) {
      const f = operations()
      if (stage === 'gate') f.value.waitForTurn = vi.fn(async () => { throw new Error('aborted turn') })
      else vi.mocked(f.value.verify).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('PID reused'))
      await expect(executeLocalUpgrade(f.value)).rejects.toThrow()
      expect(f.value.stop).not.toHaveBeenCalled()
      expect(f.value.backup).not.toHaveBeenCalled()
    }
  })
  it('never backs up or installs while graceful shutdown was refused or the process tree has not exited', async () => {
    for (const stage of ['stop', 'quiescent'] as const) {
      const f = operations()
      vi.mocked(f.value[stage]).mockRejectedValue(new Error('not exited'))
      await expect(executeLocalUpgrade(f.value)).rejects.toThrow('not exited')
      expect(f.value.install).not.toHaveBeenCalled()
      expect(f.value.rollback).not.toHaveBeenCalled()
      expect(f.value.backup).not.toHaveBeenCalled()
    }
  })
  it('relaunches the old application after backup failure, without changing the installation or data', async () => {
    const f = operations()
    vi.mocked(f.value.backup).mockRejectedValue(new Error('disk full'))
    await expect(executeLocalUpgrade(f.value)).rejects.toThrow('disk full')
    expect(f.value.install).not.toHaveBeenCalled()
    expect(f.value.rollback).not.toHaveBeenCalled()
    expect(f.value.relaunchPrevious).toHaveBeenCalledOnce()
  })
  it('restores only the old application after a settled installer failure before any successor started', async () => {
    const f = operations()
    vi.mocked(f.value.install).mockRejectedValue(new Error('installer exit 2'))
    await expect(executeLocalUpgrade(f.value)).rejects.toThrow('installer exit 2')
    expect(f.events.slice(-3)).toEqual(['event:rollback-application', 'rollback', 'relaunch'])
    expect(f.value.health).not.toHaveBeenCalled()
  })
  it('retains backups without rollback for an uncertain installer outcome, successor start, or postlaunch health failure', async () => {
    for (const stage of ['uncertain', 'successor', 'health']) {
      const f = operations()
      if (stage === 'health') vi.mocked(f.value.health).mockRejectedValue(new Error('health unavailable'))
      else {
        vi.mocked(f.value.install).mockRejectedValue(new Error(stage))
        vi.mocked(f.value.successorStarted).mockResolvedValue(true)
      }
      await expect(executeLocalUpgrade(f.value)).rejects.toThrow()
      expect(f.value.rollback).not.toHaveBeenCalled()
      expect(f.value.relaunchPrevious).not.toHaveBeenCalled()
      expect(f.events.at(-1)).toBe('event:failed-after-successor-start')
    }
  })
  it('stops recovery if verifying or restoring the old application fails', async () => {
    const f = operations()
    vi.mocked(f.value.install).mockRejectedValue(new Error('install failed'))
    vi.mocked(f.value.rollback).mockRejectedValue(new Error('backup changed'))
    await expect(executeLocalUpgrade(f.value)).rejects.toThrow('backup changed')
    expect(f.value.relaunchPrevious).not.toHaveBeenCalled()
  })
})
