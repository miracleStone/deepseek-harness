/** Build isolated local plugin candidates; installed link targets are read-only inputs. */
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const bundles = ['codex-fast', 'session-fast', 'session-model-picker']
const adapterDirectory = 'packages/llm/llm-pi-ai'
const pickerDirectory = 'packages/client/ui-model-selection'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Require an explicit, new output directory strictly below the repository's .artifacts.
 * Existing symlink ancestors and existing outputs are refused before any writes.
 * @param {string} root Repository root.
 * @param {string[]} args CLI arguments shared by both prepare entry points.
 * @returns {{ output: string, profilePatch: string | undefined }} Validated output and optional profile input.
 */
export function candidateOptions(root, args) {
  let output
  let profilePatch
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    if (key === '--candidate-root' && output === undefined) output = resolve(root, value)
    else if (key === '--profile-patch' && profilePatch === undefined) profilePatch = resolve(root, value)
    else throw new Error(`Unknown or repeated argument: ${key}`)
  }
  if (output === undefined) {
    throw new Error('Pass --candidate-root <new directory below .artifacts>; in-place preparation is disabled')
  }
  const artifacts = resolve(root, '.artifacts')
  const child = relative(artifacts, output)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Candidate output must be a new directory strictly below repository .artifacts')
  }
  let ancestor = artifacts
  for (const part of ['', ...child.split(sep)]) {
    ancestor = resolve(ancestor, part)
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) {
      throw new Error(`Candidate output must not traverse a symlink: ${ancestor}`)
    }
  }
  if (existsSync(output)) throw new Error(`Candidate output already exists; choose a new directory: ${output}`)
  return { output, profilePatch }
}

function providerConfig(root, profilePatch) {
  if (profilePatch === undefined) {
    const patch = readFileSync(resolve(root, 'local-plugins/codex-fast/cordis.patch.yml'), 'utf8').replaceAll('\r\n', '\n')
    const offset = patch.indexOf('      config:\n')
    if (offset === -1) throw new Error('Missing preserved provider configuration in codex-fast patch')
    return patch.slice(offset)
  }
  const original = readFileSync(profilePatch, 'utf8').replaceAll('\r\n', '\n')
  const matches = [...original.matchAll(/^- id: llm-pi-ai\n/gm)]
  if (matches.length !== 1) throw new Error('Expected exactly one llm-pi-ai profile override')
  const start = matches[0].index
  const end = original.indexOf('\n- ', start + 1)
  const row = original.slice(start, end === -1 ? undefined : end).trimEnd()
  const configStart = row.indexOf('\n  config:\n')
  if (configStart === -1) throw new Error('The pi-ai override has no config to preserve')
  let config = row.slice(configStart + 1)
  const marker = '      openai-codex:\n'
  if (config.split(marker).length !== 2) throw new Error('Expected exactly one openai-codex route')
  if (/^        serviceTier:/m.test(config)) throw new Error('Review the existing serviceTier before preparing candidates')
  config = config.replace(marker, `${marker}        serviceTier: fast\n`)
  return config.split('\n').map(line => `    ${line}`).join('\n') + '\n'
}

function adapterPeers(root, runtime) {
  const source = readJson(resolve(root, adapterDirectory, 'package.json'))
  const peers = { ...source.peerDependencies, ...source.dependencies }
  const vendorDirectories = {
    '@deepseek-ai/cordis': 'cordis',
    '@deepseek-ai/cordis-plugin-loader': 'loader',
    '@deepseek-ai/schemastery': 'schemastery',
  }
  for (const name of Object.keys(peers)) {
    if (name.startsWith('@deepseek-ai/dsh-')) peers[name] = runtime
    else if (vendorDirectories[name]) peers[name] = `~${readJson(resolve(root, 'vendor', vendorDirectories[name], 'package.json')).version}`
    else peers[name] = readJson(resolve(root, adapterDirectory, 'node_modules', name, 'package.json')).version
  }
  return peers
}

function candidateManifest(root, bundle, runtime, peers) {
  const manifest = readJson(resolve(root, 'local-plugins', bundle, 'package.json'))
  manifest.engines = { ...manifest.engines, dsh: runtime }
  manifest.peerDependencies = bundle === 'session-model-picker'
    ? { '@deepseek-ai/cordis': peers['@deepseek-ai/cordis'] }
    : { ...peers }
  if (bundle === 'session-fast') {
    manifest.exports['.'] = './host.js'
    manifest.exports['./client'] = './client.js'
    manifest.peerDependencies['@deepseek-ai/dsh-storage-domain'] = runtime
    manifest.peerDependencies.zod = readJson(resolve(root, 'packages/storage/storage-domain/node_modules/zod/package.json')).version
  }
  if (bundle === 'session-model-picker') {
    manifest.dsh.client = readJson(resolve(root, pickerDirectory, 'package.json')).dsh.client
  }
  return manifest
}

async function bundleFast(root, output) {
  const { Rolldown } = await import('tsdown')
  const host = await Rolldown.rolldown({
    input: resolve(output, 'index.js'),
    external: id => !id.startsWith('.') && !isAbsolute(id),
  })
  try {
    await host.write({ file: resolve(output, 'host.js'), format: 'esm' })
  } finally {
    await host.close()
  }
  const client = await Rolldown.rolldown({ input: resolve(root, 'local-plugins/session-fast/client.js') })
  try {
    await client.write({ file: resolve(output, 'client.js'), format: 'esm' })
  } finally {
    await client.close()
  }
}

function packageFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return packageFiles(resolve(directory, entry.name)).map(file => `${entry.name}/${file}`)
    return entry.name === 'package.json' ? [] : [entry.name]
  })
}

/**
 * Assemble three candidates from current lib outputs without changing source manifests or runtime files.
 * Failure leaves an incomplete output directory without a completion marker; choose a new directory to retry.
 * Metadata qualification does not establish runtime compatibility; built integration checks remain required.
 * @param {string} root Repository root, or a private synthetic fixture root in unit tests.
 * @param {string[]} args Explicit candidate arguments.
 * @returns {Promise<string>} Completed candidate root containing all three package directories.
 */
export async function prepareCandidates(root, args) {
  root = realpathSync(root)
  const { output, profilePatch } = candidateOptions(root, args)
  const runtime = readJson(resolve(root, 'package.json')).version
  const adapter = resolve(root, adapterDirectory, 'lib/index.js')
  const adapterText = readFileSync(adapter, 'utf8')
  if (!adapterText.includes('llm-pi-ai/service-tier')) throw new Error('Build the current request-tier adapter before preparing candidates')
  const pickerText = readFileSync(resolve(root, pickerDirectory, 'lib/client.js'), 'utf8')
  if (!pickerText.includes('conversation.input.model.options')) throw new Error('Build the current extended model picker before preparing candidates')
  const config = providerConfig(root, profilePatch)
  const peers = adapterPeers(root, runtime)
  const manifests = Object.fromEntries(bundles.map(bundle => [bundle, candidateManifest(root, bundle, runtime, peers)]))
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output)
  for (const bundle of bundles) {
    const source = resolve(root, 'local-plugins', bundle)
    const target = resolve(output, bundle)
    mkdirSync(target)
    for (const file of ['icon.png', 'README.md', 'README.zh.md']) copyFileSync(resolve(source, file), resolve(target, file))
    cpSync(resolve(source, 'locale'), resolve(target, 'locale'), { recursive: true })
  }
  for (const bundle of ['codex-fast', 'session-fast']) {
    const target = resolve(output, bundle)
    copyFileSync(adapter, resolve(target, 'adapter.js'))
    const disabled = bundle === 'codex-fast' ? '' : '- id: codex-fast-adapter\n  disabled: true\n'
    const id = bundle === 'codex-fast' ? 'codex-fast-adapter' : 'session-fast-adapter'
    const patch = `- id: llm-pi-ai\n  disabled: true\n${disabled}- insert:\n    - id: ${id}\n      name: "${manifests[bundle].name}"\n${config}`
    writeFileSync(resolve(target, 'cordis.patch.yml'), patch)
  }
  const fast = resolve(output, 'session-fast')
  for (const file of ['index.js', 'api.js', 'preferences.js']) copyFileSync(resolve(root, 'local-plugins/session-fast', file), resolve(fast, file))
  await bundleFast(root, fast)
  const picker = resolve(output, 'session-model-picker')
  for (const file of ['index.js', 'cordis.patch.yml']) copyFileSync(resolve(root, 'local-plugins/session-model-picker', file), resolve(picker, file))
  writeFileSync(resolve(picker, 'client.js'), pickerText.replaceAll('@deepseek-ai/dsh-client-ui-model-selection', manifests['session-model-picker'].name))
  for (const bundle of bundles) {
    const directory = resolve(output, bundle)
    manifests[bundle].files = packageFiles(directory)
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify(manifests[bundle], null, 2) + '\n')
  }
  writeFileSync(resolve(output, 'candidate-build.json'), JSON.stringify({ runtime, bundles }, null, 2) + '\n')
  console.log(`Prepared isolated candidates for DSH ${runtime}: ${output}. No plugin was installed or activated.`)
  return output
}
