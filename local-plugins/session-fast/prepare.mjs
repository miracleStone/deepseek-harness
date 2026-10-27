/** Assemble the two local deployment bundles from current built artifacts. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(directory, '../..')
const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
copyFileSync(resolve(directory, 'index.js'), resolve(directory, manifest.exports['.']))
copyFileSync(resolve(directory, 'client.js'), resolve(directory, manifest.exports['./client']))
const originalPatch = readFileSync(resolve(root, 'local-plugins/codex-fast/cordis.patch.yml'), 'utf8')
const config = originalPatch.slice(originalPatch.indexOf('      config:\n'))
if (!config.startsWith('      config:\n')) throw new Error('Missing preserved provider configuration')
const adapterPath = resolve(root, 'packages/llm/llm-pi-ai/lib/index.js')
if (!readFileSync(adapterPath, 'utf8').includes('llm-pi-ai/service-tier')) throw new Error('Build the request-tier extension first')
copyFileSync(adapterPath, resolve(directory, 'adapter.js'))
writeFileSync(resolve(directory, 'cordis.patch.yml'), '- id: llm-pi-ai\n  disabled: true\n- id: codex-fast-adapter\n  disabled: true\n- insert:\n    - id: session-fast-adapter\n      name: "@local/dsh-session-fast"\n' + config)
const picker = resolve(root, 'local-plugins/session-model-picker')
mkdirSync(picker, { recursive: true })
const client = readFileSync(resolve(root, 'packages/client/ui-model-selection/lib/client.js'), 'utf8')
if (!client.includes('conversation.input.model.options')) throw new Error('Build the extended model picker first')
writeFileSync(resolve(picker, 'client.js'), client.replaceAll('@deepseek-ai/dsh-client-ui-model-selection', '@local/dsh-session-model-picker'))
for (const target of [directory, picker]) {
  mkdirSync(resolve(target, 'locale'), { recursive: true })
  copyFileSync(resolve(root, 'local-plugins/codex-fast/icon.png'), resolve(target, 'icon.png'))
}
console.log('Prepared updated adapter and menu bundles without modifying the original profile.')
