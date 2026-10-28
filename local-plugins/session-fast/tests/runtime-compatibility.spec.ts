import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '../../../packages/boot/app-boot/src/plugin-compatibility.ts'
import { Config, resolveProfiles } from '../../../packages/llm/llm-pi-ai/src/config.ts'

interface Manifest {
  name: string
  version: string
  engines?: { dsh?: string }
  peerDependencies?: Record<string, string>
}

const root = new URL('../../../', import.meta.url)
const manifest = (path: string): Manifest => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Manifest
const runtime = manifest('package.json').version
const bundles = ['codex-fast', 'session-fast', 'session-model-picker'] as const

describe('local Fast bundle runtime qualification', () => {
  it.each(bundles)('admits %s only on the current qualified DSH runtime', (bundle) => {
    const metadata = manifest(`local-plugins/${bundle}/package.json`)
    expect(metadata.engines?.dsh).toBe(runtime)
    expect(evaluatePluginCompatibility(metadata, {}, runtime)).toBeUndefined()
    expect(evaluatePluginCompatibility(metadata, {}, '0.2.1-rc.2')).toMatchObject({
      requirements: { 'engines.dsh': runtime }, exempted: false,
    })
    expect(evaluatePluginCompatibility({ ...metadata, engines: { dsh: '0.2.1-rc.2' } }, {}, runtime))
      .toMatchObject({ requirements: { 'engines.dsh': '0.2.1-rc.2' }, exempted: false })
  })

  it.each(['codex-fast', 'session-fast'])('aligns %s peers with the adapter and vendored runtime', (bundle) => {
    const peers = manifest(`local-plugins/${bundle}/package.json`).peerDependencies!
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

  it.each(['default', 'fast'] as const)('retains the %s tier through current adapter and pi-ai catalog APIs', (serviceTier) => {
    const providers = Config({ providers: { 'openai-codex': { serviceTier } } }).providers.get()
    const route = resolveProfiles(providers).get('openai-codex')
    expect(route?.serviceTier).toBe(serviceTier)
    const models = route?.piProvider?.getModels()
    expect(models?.length).toBeGreaterThan(0)
    expect(models?.every(model => model.api === 'openai-codex-responses')).toBe(true)
  })
})
