/** Log-only workspace grants remain ordered raw events, not assistant responses. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const expectedPath = fileURLToPath(new URL('./expected/workspace-roots-projection.json', import.meta.url))
const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))

function isWorkspaceRoots(value: unknown): value is { type: 'sandbox/workspace-roots' } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'type' in value && value.type === 'sandbox/workspace-roots'
}

it('retains workspace-root changes and clearing in event order without replacing the final response', async () => {
  const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as { finalResponse: string }
  const events = [
    { type: 'sandbox/workspace-roots', seq: 3, time: 0, data: { additionalWorkspaceRoots: ['/projects/library', '/projects/tools'] } },
    { type: 'sandbox/workspace-roots', seq: 4, time: 0, data: { additionalWorkspaceRoots: [] } },
  ]
  const harness = createProcessDeepSeekHarness({
    command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_TEXT: expected.finalResponse, FAKE_SESSION_EVENTS: JSON.stringify(events) }),
    description: 'scripted SDK workspace-root projection', initializeTimeoutMs: 5000,
  })
  try {
    const result = await harness.run('Keep the assistant response.')
    const projection = {
      finalResponse: result.finalResponse,
      workspaceRootsEvents: result.events.filter(isWorkspaceRoots),
      workspaceRootsNotifications: result.notifications.filter(notification => notification.method === 'session.event'
        && isWorkspaceRoots(notification.params.event)).map((notification) => {
        if (notification.method !== 'session.event') throw new Error('Expected a Session event notification')
        expect(notification.params.sessionId).toBe(result.sessionId)
        return { method: notification.method, event: notification.params.event }
      }),
      eventOrder: result.events.map(event => event.type),
      assistantTexts: result.events.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
    }
    expect(projection).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
    expect(projection.workspaceRootsEvents).toEqual(events)
    for (const event of projection.workspaceRootsEvents) {
      expect(event).not.toHaveProperty('surfaceOp')
      expect(event).not.toHaveProperty('sourceEventSeqs')
    }
  } finally {
    await harness.close()
  }
})
