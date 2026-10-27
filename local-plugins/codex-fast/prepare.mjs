/** Prepare a local deployment from the built adapter and an existing profile's route settings. */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const profilePatch = process.argv[2]
if (!profilePatch) throw new Error('Pass the existing desktop profile cordis.patch.yml path')
const original = readFileSync(resolve(profilePatch), 'utf8').replaceAll('\r\n', '\n')
const matches = [...original.matchAll(/^- id: llm-pi-ai\n/gm)]
if (matches.length !== 1) throw new Error('Expected exactly one llm-pi-ai profile override')
const start = matches[0].index
const end = original.indexOf('\n- ', start + 1)
const row = original.slice(start, end === -1 ? undefined : end).trimEnd()
const configStart = row.indexOf('\n  config:\n')
if (configStart === -1) throw new Error('The current pi-ai override has no config to preserve')
let config = row.slice(configStart + 1)
const marker = '      openai-codex:\n'
if (config.split(marker).length !== 2) throw new Error('Expected exactly one openai-codex route')
if (/^        serviceTier:/m.test(config)) throw new Error('Review the existing serviceTier before preparing this bundle')
config = config.replace(marker, `${marker}        serviceTier: fast\n`)
const patch = '- id: llm-pi-ai\n  disabled: true\n- insert:\n    - id: codex-fast-adapter\n      name: "@local/dsh-codex-fast"\n'
  + config.split('\n').map(line => `    ${line}`).join('\n') + '\n'
const artifact = fileURLToPath(new URL('../../packages/llm/llm-pi-ai/lib/index.js', import.meta.url))
if (!readFileSync(artifact, 'utf8').includes('serviceTier: z.union')) {
  throw new Error('Build the adapter with serviceTier support before preparing the bundle')
}
copyFileSync(artifact, resolve(directory, 'adapter.js'))
writeFileSync(resolve(directory, 'cordis.patch.yml'), patch)
console.log('Prepared a local adapter copy and preserved provider settings; the source profile was not modified.')
