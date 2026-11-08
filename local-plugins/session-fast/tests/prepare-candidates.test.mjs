/** Private synthetic lib outputs exercise packaging without rebuilding or modifying linked plugins. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { candidateOptions, prepareCandidates } from '../../build-candidates.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const bundles = ['codex-fast', 'session-fast', 'session-model-picker']
const json = path => JSON.parse(readFileSync(path, 'utf8'))

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'dsh-local-candidates-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const put = (path, value) => {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  put('package.json', { version: '0.2.2-rc.1' })
  for (const [directory, version] of [['cordis', '4.1.0'], ['loader', '1.1.0'], ['schemastery', '3.19.0']]) {
    put(`vendor/${directory}/package.json`, { version })
  }
  put('packages/llm/llm-pi-ai/package.json', {
    peerDependencies: { '@deepseek-ai/cordis': 'workspace:~', '@deepseek-ai/cordis-plugin-loader': 'workspace:~', '@deepseek-ai/dsh-llm': 'workspace:*' },
    dependencies: { '@deepseek-ai/schemastery': 'workspace:~', '@earendil-works/pi-ai': '^1.3.0' },
  })
  put('packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/package.json', { version: '1.3.9' })
  put('packages/storage/storage-domain/node_modules/zod/package.json', { version: '4.5.0' })
  put('packages/llm/llm-pi-ai/lib/index.js', 'export const event = "llm-pi-ai/service-tier";\n')
  put('packages/client/ui-model-selection/package.json', { dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-remotes'] } } })
  put('packages/client/ui-model-selection/lib/client.js', 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-model-selection", factory() { return "conversation.input.model.options" } });\n')
  for (const bundle of bundles) {
    put(`local-plugins/${bundle}/package.json`, {
      name: `@local/dsh-${bundle}`, version: '1.0.4', type: 'module', engines: { dsh: '0.2.2-alpha.2' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: [] } },
      exports: bundle === 'codex-fast' ? { '.': './adapter.js' } : { '.': './index.js', './client': './client.js' },
      peerDependencies: { '@deepseek-ai/cordis': '~old' },
    })
    for (const file of ['README.md', 'README.zh.md', 'icon.png', 'locale/en.json', 'locale/zh.json']) put(`local-plugins/${bundle}/${file}`, '{}\n')
    put(`local-plugins/${bundle}/cordis.patch.yml`, '      config:\n        providers:\n          openai-codex:\n            serviceTier: fast\n')
    for (const file of ['adapter.js', 'host-v1.0.4.js', 'client-v1.0.4.js', 'client.js']) put(`local-plugins/${bundle}/${file}`, '// installed alpha.2 artifact; must remain unchanged\n')
  }
  put('local-plugins/session-fast/index.js', 'export { event } from "./adapter.js"; export { api } from "./api.js"; export { preference } from "./preferences.js";\n')
  put('local-plugins/session-fast/api.js', 'export const api = "candidate-api";\n')
  put('local-plugins/session-fast/preferences.js', 'export const preference = "candidate-preference";\n')
  put('local-plugins/session-fast/client.js', 'window.__ModuleLoader__.load({ id: "@local/dsh-session-fast", factory() { return "source-fast-client" } });\n')
  put('local-plugins/session-model-picker/index.js', 'export function apply() {}\n')
  return { root, put }
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = resolve(entry.parentPath, entry.name)
      return [path, readFileSync(path).toString('base64')]
    }))
}

test('requires explicit isolated output and refuses existing or source directories', t => {
  const { root } = fixture(t)
  for (const args of [[], ['legacy-profile.yml'], ['--candidate-root'], ['--candidate-root', 'local-plugins/session-fast'], ['--candidate-root', '.artifacts'], ['--candidate-root', '.artifacts/../local-plugins/session-fast'], ['--unknown', 'value']]) {
    assert.throws(() => candidateOptions(root, args))
  }
  mkdirSync(resolve(root, '.artifacts/existing'), { recursive: true })
  assert.throws(() => candidateOptions(root, ['--candidate-root', '.artifacts/existing']), /already exists/)
  assert.deepEqual(candidateOptions(root, ['--candidate-root', '.artifacts/new']), { output: resolve(root, '.artifacts/new'), profilePatch: undefined })
})

test('refuses output paths redirected into linked sources', t => {
  const { root } = fixture(t)
  mkdirSync(resolve(root, '.artifacts'))
  symlinkSync(resolve(root, 'local-plugins'), resolve(root, '.artifacts/source-link'), 'junction')
  assert.throws(() => candidateOptions(root, ['--candidate-root', '.artifacts/source-link/new']), /symlink/)
})

test('both prepare CLIs reject implicit in-place preparation', () => {
  for (const bundle of ['codex-fast', 'session-fast']) {
    const child = spawnSync(process.execPath, [resolve(repository, 'local-plugins', bundle, 'prepare.mjs')], { encoding: 'utf8' })
    assert.equal(child.error, undefined)
    assert.equal(child.signal, null)
    assert.notEqual(child.status, 0)
    assert.match(child.stderr, /in-place preparation is disabled/)
  }
})

test('packages fresh lib artifacts and manifests without writing any source input', async t => {
  const { root } = fixture(t)
  const before = snapshot(root)
  const output = await prepareCandidates(root, ['--candidate-root', '.artifacts/candidates'])
  assert.deepEqual(json(resolve(output, 'candidate-build.json')), { runtime: '0.2.2-rc.1', bundles })
  for (const bundle of bundles) {
    const directory = resolve(output, bundle)
    const manifest = json(resolve(directory, 'package.json'))
    assert.equal(manifest.engines.dsh, '0.2.2-rc.1')
    assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.1.0')
    for (const [name, version] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.2.2-rc.1')
    }
    for (const path of manifest.files) assert.ok(readFileSync(resolve(directory, path)).length > 0)
    for (const path of Object.values(manifest.exports)) assert.ok(readFileSync(resolve(directory, path)).length > 0)
    for (const file of ['README.md', 'README.zh.md', 'locale/en.json', 'locale/zh.json', 'icon.png', 'cordis.patch.yml']) assert.ok(manifest.files.includes(file))
    if (bundle !== 'session-model-picker') {
      assert.equal(manifest.peerDependencies['@earendil-works/pi-ai'], '1.3.9')
      assert.equal(manifest.peerDependencies['@deepseek-ai/cordis-plugin-loader'], '~1.1.0')
      assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '~3.19.0')
      assert.equal(readFileSync(resolve(directory, 'adapter.js'), 'utf8'), readFileSync(resolve(root, 'packages/llm/llm-pi-ai/lib/index.js'), 'utf8'))
    }
  }
  const host = readFileSync(resolve(output, 'session-fast/host.js'), 'utf8')
  assert.match(host, /candidate-api/)
  assert.match(host, /llm-pi-ai\/service-tier/)
  assert.doesNotMatch(host, /installed alpha/)
  assert.match(readFileSync(resolve(output, 'session-fast/client.js'), 'utf8'), /source-fast-client/)
  const picker = readFileSync(resolve(output, 'session-model-picker/client.js'), 'utf8')
  assert.match(picker, /@local\/dsh-session-model-picker/)
  assert.doesNotMatch(picker, /@deepseek-ai\/dsh-client-ui-model-selection/)
  assert.equal(json(resolve(output, 'session-fast/package.json')).peerDependencies.zod, '4.5.0')
  assert.deepEqual(json(resolve(output, 'session-model-picker/package.json')).dsh.client.inject, ['@deepseek-ai/dsh-api-remotes'])
  for (const [path, bytes] of Object.entries(before)) assert.equal(readFileSync(path).toString('base64'), bytes, path)
  await assert.rejects(prepareCandidates(root, ['--candidate-root', '.artifacts/candidates']), /already exists/)
})

test('optional profile input preserves routes and never modifies the profile', async t => {
  const { root, put } = fixture(t)
  const original = '- id: llm-pi-ai\n  config:\n    providers:\n      openai-codex:\n        model: gpt-test\n      other:\n        key: untouched\n- id: other\n  disabled: false\n'
  put('profile.yml', original)
  const output = await prepareCandidates(root, ['--candidate-root', '.artifacts/from-profile', '--profile-patch', 'profile.yml'])
  assert.equal(readFileSync(resolve(root, 'profile.yml'), 'utf8'), original)
  for (const bundle of ['codex-fast', 'session-fast']) {
    const patch = readFileSync(resolve(output, bundle, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /serviceTier: fast/)
    assert.match(patch, /model: gpt-test/)
    assert.match(patch, /key: untouched/)
    assert.doesNotMatch(patch, /id: other/)
  }
})

test('rejects missing built extensions before creating any output', async t => {
  const { root, put } = fixture(t)
  put('packages/llm/llm-pi-ai/lib/index.js', 'export const old = true;\n')
  await assert.rejects(prepareCandidates(root, ['--candidate-root', '.artifacts/not-built']), /Build the current request-tier adapter/)
  assert.throws(() => readFileSync(resolve(root, '.artifacts/not-built/candidate-build.json')), { code: 'ENOENT' })
})
