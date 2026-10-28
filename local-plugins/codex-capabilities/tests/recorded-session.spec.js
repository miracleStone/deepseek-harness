/** Keyless persisted-session replay through the shipped headless profile and native tool executor. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import {
  materializeProfilePatch, latestPersistedSessionPaths, normalizeSessionSnapshots,
  normalizeSessionSnapshot, redactSessionSnapshotIds, normalizedSystemPrompts,
  normalizedToolSchemas, formatSystemPromptSnapshot, formatToolSchemasSnapshot,
  REPLAY_CREDENTIAL_ENV, parseSnapshotManifest,
} from '@deepseek-ai/dsh-session-snapshot'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./recorded-image/', import.meta.url))
const fixture = join(fixtureDir, 'session.v4.jsonl')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
const records = log => log.trim().split('\n').map(line => JSON.parse(line))
const contextOf = log => ({ cwd: records(log)[0].cwd, sessionIds: [records(log)[0].id] })

/** Preserve complete text while tokenizing only the run-owned JSON-quoted paths that shared path scrubbing cannot recognize on Windows. */
function portableQuotedPaths(log) {
  const rows = records(log)
  const cwd = rows[0].cwd
  if (cwd === '{{cwd}}') return log
  for (const row of rows) {
    const message = row.type === 'user/message' ? row.data : row.type === 'tool/result' ? row.data.message : undefined
    if (message?.source.kind === 'runtime-context') {
      const replace = text => text.replaceAll(JSON.stringify(cwd), JSON.stringify('{{cwd}}'))
      for (const block of message.content) if (block.type === 'text') block.text = replace(block.text)
      for (const section of message.source.sections) section.text = replace(section.text)
    }
    if (row.type === 'tool/result' && row.data.meta?.originalPath) {
      const path = row.data.meta.originalPath
      const portable = `{{cwd}}/${relative(cwd, path).split(sep).join('/')}`
      for (const block of message.content) {
        if (block.type === 'text') block.text = block.text.replaceAll(JSON.stringify(path), JSON.stringify(portable))
      }
    }
  }
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

it('replays a native image call and compares its complete durable Session and model-visible schema', async () => {
  const expected = await readFile(fixture, 'utf8')
  expect(parseSnapshotManifest(await readFile(join(fixtureDir, 'snapshot.yml'), 'utf8'))).toMatchObject({ profile: 'headless', recording: 'authored' })
  expect(expected).not.toMatch(/recorded-token|recorded-refresh|dsh-codex-recorded-|[A-Z]:\\\\/u)
  const task = records(expected).find(event => event.type === 'user/message' && event.data.source.kind === 'user').data.content[0].text
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    const patch = join(fixtureDir, 'cordis.snapshot.yml')
    let actual
    let actualContext
    let toolFailure
    const result = await runLoaderSmoke({
      label: 'local Codex recorded native image', tempDirPrefix: 'dsh-codex-recorded-',
      binScript: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm',
      configPath: patch, tsconfigPath: join(repo, 'tsconfig.json'),
      binArgs: ['--profile', 'headless', '--patch', '.snapshot-patches/0-cordis.snapshot.yml', task],
      env: {
        ...REPLAY_CREDENTIAL_ENV, DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: fixture,
        DSH_SNAPSHOT_PROVIDER: 'deepseek-official', DSH_SNAPSHOT_MODEL: 'deepseek-v4-flash-vision-exp',
        CODEX_REPLAY_BASE_URL: `http://127.0.0.1:${address.port}/codex/`, DSH_TELEMETRY_DISABLED: '1',
      },
      prepare: async cwd => {
        await mkdir(join(cwd, '.snapshot-patches'))
        materializeProfilePatch(patch, cwd, 'headless', join(cwd, '.snapshot-patches'), 0)
      },
      inspect: async cwd => {
        const root = join(cwd, '.dsh/sessions')
        const files = latestPersistedSessionPaths(await readdir(root, { recursive: true }))
        expect(files).toHaveLength(1)
        actual = await readFile(join(root, files[0]), 'utf8')
        actualContext = contextOf(actual)
        const events = parseSessionLog(actual)
        const imageResult = events.find(event => event.type === 'tool/result').data
        if (imageResult.message.isError) { toolFailure = imageResult.message.content; return }
        expect(imageResult.message.content).toEqual([
          { type: 'text', text: expect.stringContaining('Generated image with gpt-image-2.5-flare;') },
          { type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png', width: 1, height: 1 }) },
        ])
        expect(await readFile(imageResult.meta.originalPath)).toEqual(png)
      },
    })
    expect(toolFailure, result.stderr).toBeUndefined()
    expect(result.stdout).toBe('DONE\n')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: '/codex/images/generations', headers: {
      authorization: 'Bearer recorded-token', 'chatgpt-account-id': 'recorded-account',
    }, body: { prompt: 'A tiny red cube', model: 'gpt-image-2.5-flare', size: 'auto', quality: 'auto', background: 'auto' } })
    const prompts = normalizedSystemPrompts(actual, actualContext)
    const schemas = normalizedToolSchemas(actual, actualContext)
    const sidecars = {
      'system-prompt.expected.md': formatSystemPromptSnapshot(prompts[0], prompts.slice(1)),
      'tool-schemas.expected.json': formatToolSchemasSnapshot(schemas[0], schemas.slice(1)),
    }
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await writeFile(fixture, normalizeSessionSnapshot(redactSessionSnapshotIds([portableQuotedPaths(actual)])[0], actualContext, { identityMode: 'preserve' }))
      for (const [name, content] of Object.entries(sidecars)) await writeFile(join(fixtureDir, name), content)
    } else {
      expect(normalizeSessionSnapshots([portableQuotedPaths(actual)], actualContext, { nativeWriterOutput: true }))
        .toEqual(normalizeSessionSnapshots([expected], contextOf(expected), { nativeWriterOutput: true }))
      for (const [name, content] of Object.entries(sidecars)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    }
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
