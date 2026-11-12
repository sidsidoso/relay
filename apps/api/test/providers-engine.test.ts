import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { receiveInbound, getConversation } from '../src/core/conversations'
import { loadKnowledge, searchKnowledge } from '../src/agent/knowledge'
import { ClaudeProvider } from '../src/agent/providers/claude'
import { OllamaProvider } from '../src/agent/providers/ollama'
import { runAgentTurn, KNOWLEDGE_HEADER, type EngineDeps } from '../src/agent/engine'
import { listRuns } from '../src/agent/runs'
import type { Provider } from '../src/agent/providers/types'
import { fakeFetch, fixture, type Recorded } from './fake-fetch'

const KB = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
let deps: EngineDeps

async function setup(provider: Provider) {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  channels.register({ id: 'widget', send: async () => {} })
  deps = { db, bus: new EventBus(), channels, provider, knowledge: () => KB }
}
const claude = (responses: Recorded[]) => {
  const f = fakeFetch(responses)
  return { provider: new ClaudeProvider({ apiKey: 'test-key', maxRetries: 0, fetch: f.fetch }), requests: f.requests }
}
const ask = (text: string) => receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'text', text }).conversation.id

describe('agent turns over recorded provider responses', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('Claude: search, then answer; the thinking turn is replayed unchanged and all passages are sent', async () => {
    const toolUse = fixture('claude/tool-use.json')
    const answer = fixture('claude/answer.json')
    const { provider, requests } = claude([{ body: toolUse }, { body: answer }])
    await setup(provider)
    const id = ask('How much is a meeting room?')

    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(getConversation(deps, id)!.messages.at(-1)).toMatchObject({ sender: 'agent', text: answer.content[1].text })

    const second = requests[1]!.body.messages
    expect(second.at(-2)).toEqual({ role: 'assistant', content: toolUse.content })
    const result = second.at(-1).content[0]
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01RelayFixtureSearch00001' })
    const sent = JSON.parse(result.content) as Array<{ title: string }>
    expect(sent.map((p) => p.title)).toEqual(searchKnowledge(KB, 'meeting room price').map((p) => p.title))

    expect(listRuns(deps.db, id)[0]).toMatchObject({
      provider: 'claude', model: 'claude-sonnet-5-5', outcome: 'replied', inputTokens: 912 + 1040, outputTokens: 64 + 48, error: null,
    })
  })

  it('Claude: a rate limit hands off and logs a failed run with a stable code', async () => {
    const { provider } = claude([{ status: 429, body: fixture('claude/rate-limit.json') }])
    await setup(provider)
    const id = ask('How much is a meeting room?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(getConversation(deps, id)!.conversation).toMatchObject({ status: 'waiting_human', handoffReason: 'The AI provider failed' })
    expect(listRuns(deps.db, id)[0]!.error).toMatch(/^claude_rate_limited: /)
  })

  it('Claude: a refusal hands off', async () => {
    const { provider } = claude([{ body: fixture('claude/refusal.json') }])
    await setup(provider)
    const id = ask('How much is a meeting room?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(listRuns(deps.db, id)[0]!.error).toBe('claude_refusal')
  })

  it('Ollama: a model without tools still answers in text-only mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFetch([{ status: 400, body: fixture('ollama/no-tools.json') }, { body: fixture('ollama/text.json') }])
    await setup(new OllamaProvider({ url: 'http://ollama:11434', model: 'gemma2:2b', fetch: f.fetch }))
    const id = ask('hello there')
    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(getConversation(deps, id)!.messages.at(-1)!.text).toBe('Hello! How can I help you today?')
    expect(listRuns(deps.db, id)[0]).toMatchObject({ provider: 'ollama', model: 'gemma2:2b', inputTokens: 412, outputTokens: 11 })
  })

  it('Ollama: the server being down hands off', async () => {
    const f = fakeFetch([{ throws: new TypeError('fetch failed') }])
    await setup(new OllamaProvider({ url: 'http://ollama:11434', fetch: f.fetch }))
    const id = ask('hello there')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(listRuns(deps.db, id)[0]!.error).toBe('ollama_offline: fetch failed')
  })

  it('Ollama: the first text-only request already carries the knowledge passages', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFetch([{ status: 400, body: fixture('ollama/no-tools.json') }, { body: fixture('ollama/text.json') }])
    await setup(new OllamaProvider({ url: 'http://ollama:11434', model: 'gemma2:2b', fetch: f.fetch }))
    const id = ask('How much is a meeting room per hour?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(f.requests[0]!.body.messages[0].content).not.toContain(KNOWLEDGE_HEADER)
    expect(f.requests[1]!.body.messages[0].content).toContain(KNOWLEDGE_HEADER)
    expect(f.requests[1]!.body.messages[0].content).toContain('Meeting rooms')
  })
})
