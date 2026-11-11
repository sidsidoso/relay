import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL, CLAUDE_MAX_TOKENS, toAnthropicMessages, toProviderError } from '../src/agent/providers/claude'
import { ProviderError } from '../src/agent/providers/errors'
import { TOOL_SPECS } from '../src/agent/tools'
import { fakeFetch, fixture, type Recorded } from './fake-fetch'

const provider = (responses: Recorded[], model?: string) => {
  const f = fakeFetch(responses)
  return { p: new ClaudeProvider({ apiKey: 'test-key', model, maxRetries: 0, fetch: f.fetch }), requests: f.requests }
}
const ask = (p: ClaudeProvider) => p.generate({ system: 'You are the Acme assistant.', messages: [{ role: 'user', content: 'How much is a meeting room?' }], tools: TOOL_SPECS })

describe('ClaudeProvider', () => {
  it('sends a Messages API request with the tools, effort low and no sampling or thinking fields', async () => {
    const { p, requests } = provider([{ body: fixture('claude/answer.json') }])
    expect(p).toMatchObject({ id: 'claude', model: DEFAULT_CLAUDE_MODEL })
    await ask(p)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toMatch(/\/v1\/messages$/)
    const body = requests[0]!.body
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: CLAUDE_MAX_TOKENS,
      system: 'You are the Acme assistant.',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'How much is a meeting room?' }],
    })
    expect(body.tools).toEqual(TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })))
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'stream']) expect(body).not.toHaveProperty(key)
  })

  it('uses the configured model and omits tools when there are none', async () => {
    const { p, requests } = provider([{ body: fixture('claude/answer.json') }], 'claude-opus-5-5')
    await p.generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })
    expect(p.model).toBe('claude-opus-5-5')
    expect(requests[0]!.body.model).toBe('claude-opus-5-5')
    expect(requests[0]!.body).not.toHaveProperty('tools')
  })

  it('returns tool calls with usage and the raw content blocks', async () => {
    const recorded = fixture('claude/tool-use.json')
    const { p } = provider([{ body: recorded }])
    expect(await ask(p)).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'toolu_01RelayFixtureSearch00001', name: 'search_knowledge', input: { query: 'meeting room price' } }],
      text: 'Let me check our prices.',
      usage: { inputTokens: 912, outputTokens: 64 },
      raw: recorded.content,
    })
  })

  it('returns the text of a final answer, ignoring thinking blocks', async () => {
    const { p } = provider([{ body: fixture('claude/answer.json') }])
    expect(await ask(p)).toEqual({
      kind: 'text',
      text: 'A meeting room costs $20 per hour. The small room seats 4 people and the large one seats 8. You can book at the front desk or by message.',
      usage: { inputTokens: 1040, outputTokens: 48 },
    })
  })

  it('a refusal or a truncated answer is a ProviderError', async () => {
    const refused = provider([{ body: fixture('claude/refusal.json') }])
    await expect(ask(refused.p)).rejects.toMatchObject({ name: 'ProviderError', code: 'claude_refusal' })
    const cut = provider([{ body: fixture('claude/max-tokens.json') }])
    await expect(ask(cut.p)).rejects.toMatchObject({ code: 'claude_max_tokens', message: 'claude_max_tokens' })
  })

  it('maps HTTP and network failures to stable codes', async () => {
    const cases: Array<[Recorded, string]> = [
      [{ status: 429, body: fixture('claude/rate-limit.json') }, 'claude_rate_limited'],
      [{ status: 401, body: fixture('claude/auth.json') }, 'claude_auth'],
      [{ status: 529, body: fixture('claude/overloaded.json') }, 'claude_http_529'],
      [{ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } } }, 'claude_model_not_found'],
      [{ throws: new TypeError('fetch failed') }, 'claude_offline'],
    ]
    for (const [recorded, code] of cases) {
      const { p } = provider([recorded])
      const err = await ask(p).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe(code)
      expect((err as Error).message).not.toContain('test-key')
    }
  })

  it('toProviderError keeps an abort as is and wraps unknown errors', () => {
    const abort = new Anthropic.APIUserAbortError()
    expect(toProviderError(abort)).toBe(abort)
    expect(toProviderError(new Error('weird'))).toMatchObject({ code: 'claude_error', message: 'claude_error: weird' })
  })
})

describe('toAnthropicMessages', () => {
  it('drops leading assistant turns, groups tool results and keeps raw turns unchanged', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'r1', name: 'search_knowledge', input: { query: 'x' } }]
    expect(toAnthropicMessages([
      { role: 'assistant', content: 'Welcome back!' },
      { role: 'user', content: 'How much is a meeting room?' },
      { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 't1', name: 'search_knowledge', input: { query: 'meeting room' } }, { id: 't2', name: 'tag_conversation', input: { tags: ['pricing'] } }] },
      { role: 'tool', toolCallId: 't1', name: 'search_knowledge', content: 'NO_RESULTS' },
      { role: 'tool', toolCallId: 't2', name: 'tag_conversation', content: 'ok' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'search_knowledge', input: { query: 'x' } }], raw },
      { role: 'tool', toolCallId: 'r1', name: 'search_knowledge', content: '[]' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Anything else?' },
      { role: 'user', content: '  ' },
    ])).toEqual([
      { role: 'user', content: 'How much is a meeting room?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 't1', name: 'search_knowledge', input: { query: 'meeting room' } },
        { type: 'tool_use', id: 't2', name: 'tag_conversation', input: { tags: ['pricing'] } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'NO_RESULTS' },
        { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
      ] },
      { role: 'assistant', content: raw },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '[]' }] },
      { role: 'assistant', content: 'Anything else?' },
      { role: 'user', content: '[empty message]' },
    ])
  })
})
