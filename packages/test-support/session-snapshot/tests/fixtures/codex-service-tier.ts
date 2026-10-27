/** Subscription request serialization against a fail-closed, recorded-response transport. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

export const name = 'snapshot-codex-service-tier'
export const inject = ['tools', 'systemPrompt']

/**
 * Replay one recorded text response after checking the real Codex request body.
 * Every fetch is contained in this fixture; no network fallback is allowed.
 * @param ctx - isolated snapshot-process context owning transport restoration.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.on('llm-pi-ai/service-tier', async (request, next) => {
    if (request.sessionId === undefined) return next()
    assert.equal(request.defaultTier, 'default')
    return 'fast'
  })
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: ['read'] }))
    // This serializer scenario excludes execution-world paths from its model input.
    agent.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: agent.ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      text: '',
    }))
  })
  const path = process.env.DSH_SNAPSHOT_FILE
  assert.ok(path, 'Codex snapshot requires DSH_SNAPSHOT_FILE')
  const messages = parseSessionLog(await readFile(path, 'utf8'))
    .flatMap(event => event.type === 'assistant/message' ? [event.data.message] : [])
  assert.equal(messages.length, 1, 'Codex snapshot requires one recorded response')
  const text = messages[0]!.content.map((block) => {
    assert.equal(block.type, 'text', 'Codex snapshot only supports recorded text')
    return block.type === 'text' ? block.text : ''
  }).join('')
  const item = {
    type: 'message', id: 'msg_snapshot_fast', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const events = [
    { type: 'response.created', response: { id: 'resp_snapshot_fast' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: 'resp_snapshot_fast', status: 'completed', service_tier: 'priority', output: [item],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    } },
  ]
  let requests = 0
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      assert.equal(request.url, 'https://codex.snapshot.invalid/codex/responses', 'unexpected snapshot fetch; network is disabled')
      assert.equal(request.method, 'POST')
      const bytes = new Uint8Array(await request.arrayBuffer())
      const decoded = request.headers.get('content-encoding') === 'zstd'
        ? zstdDecompressSync(bytes).toString('utf8') : new TextDecoder().decode(bytes)
      const body: unknown = JSON.parse(decoded)
      assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body))
      assert.ok('service_tier' in body)
      assert.equal(body.service_tier, 'priority', 'Fast configuration must reach the final subscription request as priority')
      assert.ok('reasoning' in body && body.reasoning !== null && typeof body.reasoning === 'object')
      assert.ok('effort' in body.reasoning)
      assert.equal(body.reasoning.effort, 'high')
      assert.equal(++requests, 1, 'unexpected extra Codex request')
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/turn-stopping', () => {
    assert.equal(requests, 1, 'Codex snapshot must consume its recorded response through the real serializer')
  })
}
