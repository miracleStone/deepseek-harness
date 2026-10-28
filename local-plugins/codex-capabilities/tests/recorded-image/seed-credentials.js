/** Test-only OAuth seed for an isolated shipped-profile replay; never installed by the plugin. */
import { credentialKey } from '@deepseek-ai/dsh-credentials'
export const name = 'codex-replay-credentials'
export const inject = ['credentials']
export async function apply(ctx) {
  await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai-codex'), () => ({
    kind: 'grant', payload: { type: 'oauth', access: 'recorded-token', refresh: 'recorded-refresh', accountId: 'recorded-account', expires: Date.now() + 3600000 },
  }))
}
