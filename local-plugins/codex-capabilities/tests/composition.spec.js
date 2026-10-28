/** Source-profile composition with real registries and durable attachment storage; only OAuth storage and HTTP are fixtures. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import WebRuntime from '@deepseek-ai/dsh-web'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import * as Capabilities from '../index.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
const key = credentialKey('llm-pi-ai', 'openai-codex')
let context
let root

/** A test-owned persisted grant, preserving the production credential read/modify interface. */
class FixtureCredentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
    this.record = { kind: 'grant', payload: { type: 'oauth', access: 'composition-token', refresh: 'composition-refresh', accountId: 'composition-account', expires: Date.now() + 3600000 } }
  }
  async readRecord(requested) {
    expect(requested).toBe(key)
    return structuredClone(this.record)
  }
  async modifyRecord(requested, mutate) {
    expect(requested).toBe(key)
    const next = await mutate(structuredClone(this.record))
    if (next !== undefined) this.record = structuredClone(next)
    return structuredClone(this.record)
  }
}

afterEach(async () => {
  try { await context?.fiber.dispose() }
  finally {
    context = undefined
    vi.unstubAllGlobals()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

/** The real Loader imports the plugin namespace through a source-profile module map. */
async function loadComposition() {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-capabilities-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: credentials', '  name: fixture-credentials',
    '- id: system-prompt', '  name: system-prompt',
    '- id: tools', '  name: tools',
    '- id: web', '  name: web', '  config:', '    searchProvider: codex-subscription',
    '- id: attachments', '  name: attachments', '  config:', `    dshHome: ${JSON.stringify(root)}`,
    '- id: capabilities', '  name: codex-capabilities', '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const modules = new Map([
    ['fixture-credentials', FixtureCredentials], ['system-prompt', SystemPrompt],
    ['tools', ToolsService], ['web', WebRuntime], ['attachments', LocalAttachmentStore],
    ['codex-capabilities', Capabilities],
  ])
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register() { throw new Error('Unexpected Loader hook registration') },
    getOrCreateModuleJob() { throw new Error('Unexpected Loader module job') },
    resolveSync() { throw new Error('Unexpected Loader sync resolution') },
    load() { throw new Error('Unexpected Loader load') },
  }
  await mountRootInclude(ctx, configPath)
  await ctx.loader.await()
  return ctx
}

it('loads the selected search provider and native image definition, preserves originals, and removes contributions on unload', async () => {
  const network = vi.fn(async (input, init) => {
    const url = String(input)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer composition-token')
    expect(new Headers(init.headers).get('chatgpt-account-id')).toBe('composition-account')
    expect(init.redirect).toBe('error')
    if (url === 'https://chatgpt.com/backend-api/codex/alpha/search') {
      return Response.json({ results: [{ url: 'https://example.com/reference', title: 'Reference', snippet: 'Public source' }] })
    }
    if (url === 'https://chatgpt.com/backend-api/codex/images/generations') {
      return Response.json({ data: [{ b64_json: png.toString('base64') }] })
    }
    throw new Error(`Unexpected external request: ${url}`)
  })
  vi.stubGlobal('fetch', network)
  const ctx = await loadComposition()
  expect('default' in Capabilities).toBe(false)
  expect(await ctx.web.search({ query: 'source reference', maxResults: 1 })).toEqual({
    sources: [{ url: 'https://example.com/reference', title: 'Reference', snippet: 'Public source' }], truncated: false,
  })
  const schemas = ctx.tools.schemas()
  expect(schemas.map(schema => schema.name)).toEqual(['codex_image_generate'])
  expect(schemas[0].parameters).toMatchObject({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } })
  expect(schemas[0].parameters.properties.model.enum).toEqual(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
  const tool = ctx.tools.get('codex_image_generate')
  expect(tool).toBeDefined()
  const args = { prompt: 'A tiny red cube' }
  const value = await tool.execute(args, {
    callId: 'composition-image', signal: new AbortController().signal,
    agent: { session: { deriveMessages: () => [] } },
  })
  const content = tool.output.render(args, value)
  expect(content[0]).toMatchObject({ type: 'text' })
  expect(content[0].text).toContain('Generated image with gpt-image-2.5-flare;')
  expect(content[1]).toEqual({ type: 'image', attachment: value.image })
  expect(value.image).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
  expect(value.originalPath).toBeDefined()
  expect(await readFile(value.originalPath)).toEqual(png)
  const preview = await ctx.attachments.readImage(value.image)
  expect(preview.ref).toEqual(value.image)
  expect(preview.data.byteLength).toBe(value.image.bytes)
  expect(network).toHaveBeenCalledTimes(2)
  const contribution = [...ctx.loader.entries()].find(entry => entry.options.id === 'capabilities')
  expect(contribution).toBeDefined()
  await contribution.fiber.dispose()
  expect(ctx.tools.get('codex_image_generate')).toBeUndefined()
  await expect(ctx.web.search({ query: 'after unload' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  expect(network).toHaveBeenCalledTimes(2)
})
