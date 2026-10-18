/** New multi-folder conversations replay their approved roots and model context together. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SCENARIO = process.platform === 'win32' ? 'workspace-folders-pwsh' : 'workspace-folders'
const DIR = fileURLToPath(new URL(`../../../snapshots/web/${SCENARIO}`, import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')(`web snapshot: multi-folder Workspace (${SCENARIO})`, () => {
  it('records approved folders before its first request and retains them after Workspace edits', async () => {
    const scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: true,
      agentPresets: { default: 'minimal' },
      replayProviders: [{
        id: 'deepseek-messages', name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000 }],
      }],
    })
    onTestFinished(() => scaffold.close())
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    const extra = join(scaffold.workspaceCwd, 'shared-library')
    await mkdir(extra)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Multi-folder workspace')
    await workspace.addFolder(extra)
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      try {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        const input = page.locator('[data-composer-input][contenteditable="true"]').first()
        await input.waitFor()
        const prompt = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]
        if (prompt === undefined) throw new Error('Folder fixture has no user prompt')
        const settled = scaffold.whenTurnSettled()
        await input.fill(prompt)
        await input.press('Enter')
        const sessionId = await settled
        const session = scaffold.ctx.sessions.get(sessionId)
        if (session === undefined) throw new Error('Folder conversation was not published')
        expect(session.header.cwd).toBe(workspace.path)
        expect(session.header.agentPreset).toBe('minimal')
        expect(scaffold.ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([extra])
        const policy = scaffold.ctx.sandboxPolicy.resolve({ session })
        expect(policy.workspaceRoot).toBe(workspace.path)
        expect(policy.additionalWorkspaceRoots).toBeUndefined()
        const events = session.snapshotEvents()
        const rootsIndex = events.findIndex(event => event.type === 'sandbox/workspace-roots')
        const requestIndex = events.findIndex(event => event.type === 'request/header')
        expect(rootsIndex).toBeGreaterThanOrEqual(0)
        expect(requestIndex).toBeGreaterThan(rootsIndex)
        const context = events.find(event => event.type === 'user/message'
          && event.data.source.kind === 'runtime-context')
        if (context?.type !== 'user/message') throw new Error('Folder conversation has no runtime context')
        const sections = [
          { name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(workspace.path)}.` },
          {
            name: 'sandbox:workspace-folders',
            text: `Session workspace folders: ${JSON.stringify([workspace.path, extra])}. Relative paths and commands use the current working directory; use absolute paths for the other folders.`,
          },
        ]
        expect(context.data.source).toEqual({ kind: 'runtime-context', form: 'snapshot', sections })
        expect(context.data.content).toEqual([{
          type: 'text',
          text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${sections.map(section => section.text).join('\n\n')}`,
        }])
        await workspace.removeFolder(extra)
        expect(workspace.additionalPaths).toEqual([])
        expect(scaffold.ctx.sandboxPolicy.additionalRootsOf(session)).toEqual([extra])
        await page.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
        await compareOrRefreshGolden(join(DIR, 'ui.expected.md'),
          await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
        expect(tripwire.pageErrors).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'web-e2e-workspace-folders')
        throw error
      }
    } finally {
      await browser.close()
    }
  })
})
