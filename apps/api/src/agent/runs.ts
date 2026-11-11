import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { agentRuns } from '../db/schema'
import type { CoreDeps } from '../core/conversations'
import type { AgentRun } from '../core/types'

/** Stores one agent turn and broadcasts it as `agent.run.created`. */
export function recordRun(deps: CoreDeps, row: Omit<typeof agentRuns.$inferInsert, 'id' | 'createdAt'>): AgentRun {
  const run = deps.db.insert(agentRuns).values({ ...row, createdAt: new Date().toISOString() }).returning().get()
  deps.bus.emit('agent.run.created', { conversationId: run.conversationId, run })
  return run
}

/** Newest first. */
export function listRuns(db: Db, conversationId: number, limit = 50): AgentRun[] {
  return db.select().from(agentRuns).where(eq(agentRuns.conversationId, conversationId))
    .orderBy(desc(agentRuns.id)).limit(limit).all()
}
