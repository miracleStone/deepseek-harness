/** Check that local deployment preserves the original provider configuration. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('Pass the original profile patch path')
const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
const start = source.indexOf('- id: llm-pi-ai\n')
assert.notEqual(start, -1)
const end = source.indexOf('\n- ', start + 1)
const row = source.slice(start, end === -1 ? undefined : end).trimEnd()
const original = row.slice(row.indexOf('\n  config:\n') + 1)
const replacement = patch.slice(patch.indexOf('      config:\n')).trimEnd()
  .split('\n').map(line => line.slice(4)).join('\n').replace('        serviceTier: fast\n', '')
assert.equal(replacement, original)
console.log('Provider configuration preserved exactly except Codex serviceTier.')
