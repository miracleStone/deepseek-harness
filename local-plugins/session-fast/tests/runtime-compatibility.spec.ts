import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '../../../packages/boot/app-boot/src/plugin-compatibility.ts'
import { Config, resolveProfiles } from '../../../packages/llm/llm-pi-ai/src/config.ts'

interface Manifest {
  name: string
  version: string
  engines?: { dsh?: string }
  peerDependencies?: Record<string, string>
  exports?: Record<string, string>
  files?: string[]
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = (path: string): Manifest => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
const runtime = manifest('package.json').version
const legacyRuntime = '0.2.2-alpha.2'
const bundles = ['codex-fast', 'session-fast', 'session-model-picker'] as const

function candidateRoot(): string {
  const directory = process.env.DSH_LOCAL_PLUGIN_CANDIDATE_ROOT
  if (!directory) throw new Error('Set DSH_LOCAL_PLUGIN_CANDIDATE_ROOT to a completed isolated candidate build; source manifests are legacy installation inputs')
  return resolve(root, directory)
}

const candidateManifest = (bundle: string): Manifest => manifest(resolve(candidateRoot(), bundle, 'package.json'))

describe('linked legacy bundles stay qualified for the installed Desktop runtime', () => {
  it.each(bundles)('preserves %s alpha.2 qualification without relabeling old bundles', (bundle) => {
    const metadata = manifest(`local-plugins/${bundle}/package.json`)
    expect(metadata.engines?.dsh).toBe(legacyRuntime)
    expect(evaluatePluginCompatibility(metadata, {}, legacyRuntime)).toBeUndefined()
    expect(evaluatePluginCompatibility(metadata, {}, runtime)).toMatchObject({
      requirements: { 'engines.dsh': legacyRuntime }, exempted: false,
    })
    for (const [name, version] of Object.entries(metadata.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(version).toBe(legacyRuntime)
    }
  })
})

describe('isolated candidate artifact metadata qualification, not runtime execution', () => {
  it('requires a completed candidate build for the current repository runtime', () => {
    const record = JSON.parse(readFileSync(resolve(candidateRoot(), 'candidate-build.json'), 'utf8')) as {
      runtime: string
      bundles: string[]
    }
    expect(record).toEqual({ runtime, bundles })
  })

  it.each(bundles)('admits artifact %s only on the declared current DSH runtime', (bundle) => {
    const metadata = candidateManifest(bundle)
    expect(metadata.name).toBe(`@local/dsh-${bundle}`)
    expect(metadata.engines?.dsh).toBe(runtime)
    expect(evaluatePluginCompatibility(metadata, {}, runtime)).toBeUndefined()
    for (const rejected of [legacyRuntime, '0.2.1-rc.2']) {
      expect(evaluatePluginCompatibility(metadata, {}, rejected)).toMatchObject({
        requirements: { 'engines.dsh': runtime }, exempted: false,
      })
    }
    expect(metadata.files?.length).toBeGreaterThan(0)
    for (const file of metadata.files ?? []) expect(readFileSync(resolve(candidateRoot(), bundle, file)).length).toBeGreaterThan(0)
    for (const entry of Object.values(metadata.exports ?? {})) {
      if (!entry.includes('*')) expect(readFileSync(resolve(candidateRoot(), bundle, entry)).length).toBeGreaterThan(0)
    }
  })

  it.each(['codex-fast', 'session-fast'])('aligns artifact %s peers with current built dependencies', (bundle) => {
    const peers = candidateManifest(bundle).peerDependencies!
    const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [, version] of dshPeers) expect(version).toBe(runtime)
    for (const [name, directory] of [
      ['@deepseek-ai/cordis', 'cordis'],
      ['@deepseek-ai/cordis-plugin-loader', 'loader'],
      ['@deepseek-ai/schemastery', 'schemastery'],
    ] as const) expect(peers[name]).toBe(`~${manifest(`vendor/${directory}/package.json`).version}`)
    const pi = manifest('packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/package.json')
    expect(peers[pi.name]).toBe(pi.version)
    if (bundle === 'session-fast') {
      const zod = manifest('packages/storage/storage-domain/node_modules/zod/package.json')
      expect(peers[zod.name]).toBe(zod.version)
    }
  })

  it('aligns the picker artifact Cordis peer with the current vendor', () => {
    expect(candidateManifest('session-model-picker').peerDependencies?.['@deepseek-ai/cordis'])
      .toBe(`~${manifest('vendor/cordis/package.json').version}`)
  })
})

describe('source adapter catalog APIs, independent of candidate runtime execution', () => {
  it.each(['default', 'fast'] as const)('retains the %s tier through current adapter and pi-ai catalog APIs', (serviceTier) => {
    const providers = Config({ providers: { 'openai-codex': { serviceTier } } }).providers.get()
    const route = resolveProfiles(providers).get('openai-codex')
    expect(route?.serviceTier).toBe(serviceTier)
    const models = route?.piProvider?.getModels()
    expect(models?.length).toBeGreaterThan(0)
    expect(models?.every(model => model.api === 'openai-codex-responses')).toBe(true)
  })
})
