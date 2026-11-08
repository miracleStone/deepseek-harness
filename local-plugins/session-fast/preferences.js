/** Durable per-session Fast preferences, independent of provider configuration. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const preferencesSpec = defineDomain({
  name: 'codex_session_fast',
  version: 1,
  tables: { sessions: domainTable(z.object({ enabled: z.boolean() }).strict()) },
})

/** Reads the domain's committed memory; writes resolve only after durable storage. */
export class SessionFastPreferences {
  constructor(table, defaultEnabled = false) {
    this.table = table
    this.defaultEnabled = defaultEnabled
  }

  get(sessionId) {
    const enabled = this.table.get(sessionId)?.enabled ?? this.defaultEnabled
    return { enabled, serviceTier: enabled ? 'fast' : 'default' }
  }

  async set(sessionId, enabled) {
    await this.table.put(sessionId, { enabled })
    return { enabled, serviceTier: enabled ? 'fast' : 'default' }
  }
}
