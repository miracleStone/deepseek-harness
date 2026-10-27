/** Authenticated owner-only preference endpoint; no Agent or Session logging is involved. */
import { z } from 'zod'

const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
const readInput = z.object({ sessionId }).strict()
const writeInput = z.object({ sessionId, enabled: z.boolean() }).strict()

const failure = (status, code, message) => Response.json({ error: { code, message } }, { status })

/** Register a silent settings endpoint on Connection's authenticated /api channel. */
export function registerFastApi(ctx, preferences) {
  return ctx.connection.fetch.register({
    path: '/api/session-fast',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let payload
      try {
        payload = await request.json()
      } catch {
        return failure(400, 'session-fast/invalid-request', 'Expected a JSON body.')
      }
      const writing = payload !== null && typeof payload === 'object'
        && Object.hasOwn(payload, 'enabled')
      const parsed = (writing ? writeInput : readInput).safeParse(payload)
      if (!parsed.success) return failure(400, 'session-fast/invalid-request', 'Invalid Fast settings request.')
      try {
        const state = writing
          ? await preferences.set(parsed.data.sessionId, parsed.data.enabled)
          : preferences.get(parsed.data.sessionId)
        return Response.json({ enabled: state.enabled })
      } catch (error) {
        ctx.logger.warn('Session Fast preference operation failed', error)
        return failure(503, 'session-fast/storage-failed', 'Could not access the Fast setting. Try again.')
      }
    },
  })
}
