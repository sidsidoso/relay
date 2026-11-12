import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { messages } from '../src/db/schema'
import { createDb } from '../src/db/client'
import { seed } from '../src/db/seed'
import { EventBus } from '../src/core/events'
import { ChannelRegistry } from '../src/channels/types'
import { receiveInbound, getConversation, assign, postOutbound } from '../src/core/conversations'
import { loadKnowledge } from '../src/agent/knowledge'
import { DemoProvider } from '../src/agent/providers/demo'
import { runAgentTurn, buildSystemPrompt, KNOWLEDGE_HEADER, SEARCH_RULE, type EngineDeps } from '../src/agent/engine'
import { listRuns } from '../src/agent/runs'
import type { ChatMessage, GenerateRequest, Provider } from '../src/agent/providers/types'

const KB = loadKnowledge(fileURLToPath(new URL('../knowledge', import.meta.url)))
let deps: EngineDeps
const delivered: string[] = []

async function setup(provider: Provider = new DemoProvider(), timeoutMs?: number) {
  const db = createDb(':memory:')
  await seed(db)
  const channels = new ChannelRegistry()
  channels.register({ id: 'widget', send: async (_t, m) => { delivered.push(m.text ?? '') } })
  deps = { db, bus: new EventBus(), channels, provider, knowledge: () => KB, timeoutMs }
}
const ask = (text: string) => receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'text', text }).conversation.id
const last = (id: number) => getConversation(deps, id)!.messages.at(-1)!

beforeEach(async () => { delivered.length = 0; await setup() })

describe('runAgentTurn', () => {
  it('answers a question from the knowledge base and logs a replied run', async () => {
    const id = ask('How much is a meeting room?')
    const events: unknown[] = []
    deps.bus.on('agent.run.created', (e) => { events.push(e) })
    const r = await runAgentTurn(deps, id)
    expect(r.outcome).toBe('replied')
    expect(last(id)).toMatchObject({ sender: 'agent', text: expect.stringContaining('Meeting rooms') })
    expect(getConversation(deps, id)!.conversation.agentTurns).toBe(1)
    expect(listRuns(deps.db, id)[0]).toMatchObject({ provider: 'demo', model: 'scripted', outcome: 'replied', error: null })
    expect(events).toHaveLength(1)
    expect(delivered.at(-1)).toContain('Meeting rooms')
  })

  it('hands off on a handoff keyword without calling the provider', async () => {
    const provider = { id: 'spy', model: null, generate: vi.fn() }
    await setup(provider as unknown as Provider)
    const id = ask('I want to talk to a HUMANO please')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    expect(provider.generate).not.toHaveBeenCalled()
    const c = getConversation(deps, id)!.conversation
    expect(c).toMatchObject({ status: 'waiting_human', handoffReason: 'Customer asked for a human' })
    expect(last(id)).toMatchObject({ sender: 'agent', text: 'I am passing you to a person from our team. They will reply here shortly.' })
  })

  it('hands off when the knowledge base has no answer (demo flow)', async () => {
    const id = ask('Do you sell quantum computers?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    expect(getConversation(deps, id)!.conversation.handoffReason).toBe('No answer in the knowledge base')
  })

  it('hands off when the turn limit is reached', async () => {
    const id = ask('hi')
    await postOutbound(deps, id, { sender: 'agent', text: 'x' }, { agentTurns: 10 })
    ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('transferred')
    expect(getConversation(deps, id)!.conversation.handoffReason).toBe('Turn limit reached')
  })

  it('skips when assigned, unknown, or nothing new from the customer, and writes no run', async () => {
    const id = ask('hi')
    await runAgentTurn(deps, id)
    expect((await runAgentTurn(deps, id)).outcome).toBe('skipped')
    ask('price?')
    assign(deps, id, 1)
    expect((await runAgentTurn(deps, id)).outcome).toBe('skipped')
    expect(await runAgentTurn(deps, 999)).toEqual({ outcome: 'skipped' })
    expect(listRuns(deps.db, id)).toHaveLength(1)
  })

  it('sends the history as chat messages, with an [audio] placeholder', async () => {
    const seen: ChatMessage[][] = []
    await setup({ id: 'rec', model: null, generate: async (req) => { seen.push(structuredClone(req.messages)); return { kind: 'text', text: 'ok' } } })
    const id = ask('first')
    await postOutbound(deps, id, { sender: 'user', userId: 1, text: 'team answer' })
    receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'a.webm' })
    await runAgentTurn(deps, id)
    expect(seen[0]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'team answer' },
      { role: 'user', content: '[audio]' },
    ])
  })

  it('a provider error hands off and logs a failed run', async () => {
    await setup({ id: 'boom', model: 'x', generate: async () => { throw new Error('upstream 500') } })
    const id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(getConversation(deps, id)!.conversation).toMatchObject({ status: 'waiting_human', handoffReason: 'The AI provider failed' })
    expect(listRuns(deps.db, id)[0]).toMatchObject({ outcome: 'failed', error: 'upstream 500' })
  })

  it('a provider timeout aborts the request and is a failed run with error "timeout"', async () => {
    let aborted = false
    await setup({
      id: 'slow', model: null,
      generate: ({ signal }) => new Promise(() => { signal?.addEventListener('abort', () => { aborted = true }) }),
    }, 20)
    const id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('failed')
    expect(listRuns(deps.db, id)[0]!.error).toBe('timeout')
    expect(aborted).toBe(true)
  })

  it('an empty reply hands off; tool rounds are bounded; tags are applied', async () => {
    await setup({ id: 'empty', model: null, generate: async () => ({ kind: 'text', text: '   ' }) })
    const a = ask('x')
    expect((await runAgentTurn(deps, a)).outcome).toBe('transferred')
    expect(listRuns(deps.db, a)[0]!.error).toBe('empty_reply')

    let n = 0
    await setup({ id: 'loop', model: null, generate: async () => ({ kind: 'tool_calls', calls: [{ id: `t${n++}`, name: 'tag_conversation', input: { tags: ['pricing'] } }] }) })
    const b = ask('x')
    expect((await runAgentTurn(deps, b)).outcome).toBe('transferred')
    expect(n).toBe(3)
    expect(getConversation(deps, b)!.conversation).toMatchObject({ tags: ['pricing'], handoffReason: 'The agent did not finish within the tool limit' })
  })

  it('does not reply if a person took the conversation while the provider was thinking', async () => {
    let id = 0
    await setup({ id: 'race', model: null, generate: async () => { assign(deps, id, 1); return { kind: 'text', text: 'too late' } } })
    id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('skipped')
    expect(last(id).sender).toBe('contact')
  })

  it('does not hand off a conversation a person took meanwhile', async () => {
    let id = 0
    await setup({ id: 'race', model: null, generate: async () => { assign(deps, id, 1); return { kind: 'tool_calls', calls: [{ id: 't', name: 'transfer_to_human', input: {} }] } } })
    id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('skipped')
    expect(getConversation(deps, id)!.conversation).toMatchObject({ status: 'open', assigneeId: 1, handoffReason: null })
  })

  it('records token usage when the provider reports it', async () => {
    await setup({ id: 'u', model: 'm', generate: async () => ({ kind: 'text', text: 'ok', usage: { inputTokens: 12, outputTokens: 3 } }) })
    const id = ask('x')
    await runAgentTurn(deps, id)
    expect(listRuns(deps.db, id)[0]).toMatchObject({ inputTokens: 12, outputTokens: 3 })
  })
  it('passes a provider\x27s opaque raw turn back on the next tool round', async () => {
    const seen: ChatMessage[][] = []
    const raw = [{ type: 'opaque', signature: 'abc' }]
    await setup({
      id: 'raw', model: null,
      generate: async (req) => {
        seen.push(structuredClone(req.messages))
        return seen.length === 1
          ? { kind: 'tool_calls', calls: [{ id: 't1', name: 'tag_conversation', input: { tags: ['pricing'] } }], raw }
          : { kind: 'text', text: 'done' }
      },
    })
    const id = ask('price?')
    expect((await runAgentTurn(deps, id)).outcome).toBe('replied')
    expect(seen[1]!.slice(-2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'tag_conversation', input: { tags: ['pricing'] } }], raw },
      { role: 'tool', toolCallId: 't1', name: 'tag_conversation', content: 'ok' },
    ])
  })

  it('a tool_calls result without raw adds no raw key', async () => {
    const seen: ChatMessage[][] = []
    await setup({
      id: 'noraw', model: null,
      generate: async (req) => {
        seen.push(structuredClone(req.messages))
        return seen.length === 1
          ? { kind: 'tool_calls', calls: [{ id: 't1', name: 'tag_conversation', input: { tags: ['x'] } }] }
          : { kind: 'text', text: 'done' }
      },
    })
    await runAgentTurn(deps, ask('price?'))
    expect('raw' in seen[1]!.at(-2)!).toBe(false)
  })

  it('a transcribed voice message with a handoff keyword hands off without calling the provider', async () => {
    const provider = { id: 'spy', model: null, generate: vi.fn() }
    await setup(provider as unknown as Provider)
    const { conversation, message } = receiveInbound(deps, { channel: 'widget', contactKey: 'k'.repeat(64), type: 'audio', mediaPath: 'a.webm' })
    deps.db.update(messages).set({ transcription: { status: 'ok', text: 'Quero falar com um atendente', at: 'x' } }).where(eq(messages.id, message.id)).run()
    expect((await runAgentTurn(deps, conversation.id)).outcome).toBe('transferred')
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it('"agent" alone no longer hands off; "a real person" does', async () => {
    let calls = 0
    await setup({ id: 'rec', model: null, generate: async () => { calls++; return { kind: 'text', text: 'ok' } } })
    expect((await runAgentTurn(deps, ask('I am a real estate agent looking for a desk'))).outcome).toBe('replied')
    expect(calls).toBe(1)
    // Same contact key, same conversation: this is the next turn.
    expect((await runAgentTurn(deps, ask('Can I talk to a real person?'))).outcome).toBe('transferred')
    expect(calls).toBe(1)
  })
})

describe('text-only providers', () => {
  function capturing(textOnly: boolean) {
    const seen: GenerateRequest[] = []
    const provider: Provider = {
      id: 'fake', model: null, textOnly,
      async generate(req) { seen.push(req); return { kind: 'text', text: 'ok' } },
    }
    return { provider, seen }
  }

  it('get the passages that match the pending messages in the system prompt', async () => {
    const { provider, seen } = capturing(true)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-1', type: 'text', text: 'How much is a meeting room per hour?' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).toContain(KNOWLEDGE_HEADER)
    expect(seen[0]!.system).toContain('Meeting rooms')
    expect(seen[0]!.system).toContain('$20 per hour')
  })

  it('say so when nothing matched', async () => {
    const { provider, seen } = capturing(true)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-2', type: 'text', text: 'zzzz qqqq' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).toContain(`${KNOWLEDGE_HEADER} none matched`)
  })

  it('tool-capable providers keep using search_knowledge and get no passages', async () => {
    const { provider, seen } = capturing(false)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-3', type: 'text', text: 'How much is a meeting room per hour?' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).not.toContain(KNOWLEDGE_HEADER)
  })

  it('tool-capable providers are told to search the knowledge base first, and get a text-only prompt for a fallback', async () => {
    const { provider, seen } = capturing(false)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-4', type: 'text', text: 'How much is a meeting room per hour?' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.system).toContain(SEARCH_RULE)
    expect(seen[0]!.textOnlySystem).toContain(KNOWLEDGE_HEADER)
    expect(seen[0]!.textOnlySystem).toContain('$20 per hour')
  })

  it('text-only providers get no fallback prompt', async () => {
    const { provider, seen } = capturing(true)
    const { conversation } = receiveInbound(deps, { channel: 'widget', contactKey: 't-5', type: 'text', text: 'Hello' })
    await runAgentTurn({ ...deps, provider }, conversation.id)
    expect(seen[0]!.textOnlySystem).toBeUndefined()
  })

  it('buildSystemPrompt puts the instructions first', () => {
    expect(buildSystemPrompt('Be nice.', false, KB, 'x').startsWith('Be nice.\n\nRules:')).toBe(true)
    expect(buildSystemPrompt('Be nice.', true, KB, 'meeting room')).toContain('Meeting rooms')
  })
})
