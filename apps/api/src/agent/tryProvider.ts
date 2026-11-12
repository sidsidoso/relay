import { createDb } from '../db/client'
import { seed } from '../db/seed'
import { EventBus } from '../core/events'
import { ChannelRegistry } from '../channels/types'
import { getConversation, receiveInbound } from '../core/conversations'
import { loadKnowledge } from './knowledge'
import { runAgentTurn, type TurnResult } from './engine'
import { listRuns } from './runs'
import { agentTimeoutMs, selectProvider } from './providers'
import type { FetchLike } from './providers/types'

export type TryResult = {
  provider: string
  model: string | null
  outcome: TurnResult['outcome']
  reply: string | null
  error: string | null
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * One full agent turn — the app's real prompt, tools, knowledge and error handling — with the provider selected
 * from `env`, on a throwaway in-memory database. Used by `npm run try-provider`; tests pass a recorded `fetch`.
 */
export async function tryProvider(
  env: NodeJS.ProcessEnv,
  question: string,
  opts: { knowledgeDir: string; fetch?: FetchLike },
): Promise<TryResult> {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  channels.register({ id: 'widget', send: async () => {} })
  const provider = selectProvider(env, { fetch: opts.fetch })
  const passages = loadKnowledge(opts.knowledgeDir)
  const deps = { db, bus: new EventBus(), channels, provider, knowledge: () => passages, timeoutMs: agentTimeoutMs(env, provider) }
  const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 'try-provider', type: 'text', text: question })
  const result = await runAgentTurn(deps, conversation.id)
  const last = getConversation(deps, conversation.id)!.messages.at(-1)
  const run = listRuns(db, conversation.id)[0]
  return {
    provider: provider.id,
    model: provider.model,
    outcome: result.outcome,
    reply: last && last.sender !== 'contact' ? last.text : null,
    error: run?.error ?? null,
    durationMs: run?.durationMs ?? 0,
    inputTokens: run?.inputTokens ?? null,
    outputTokens: run?.outputTokens ?? null,
  }
}
