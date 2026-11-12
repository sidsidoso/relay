import { describe, it, expect, vi } from 'vitest'
import { OllamaProvider, DEFAULT_OLLAMA_MODEL, toOllamaMessages } from '../src/agent/providers/ollama'
import { ProviderError } from '../src/agent/providers/errors'
import { TOOL_SPECS } from '../src/agent/tools'
import { fakeFetch, fixture, type Recorded } from './fake-fetch'

const provider = (responses: Recorded[], model?: string) => {
  const f = fakeFetch(responses)
  return { p: new OllamaProvider({ url: 'http://ollama:11434/', model, fetch: f.fetch }), requests: f.requests }
}
const ask = (p: OllamaProvider, content = 'When are you open?') =>
  p.generate({ system: 'You are the Acme assistant.', messages: [{ role: 'user', content }], tools: TOOL_SPECS })

describe('OllamaProvider', () => {
  it('posts a non-streaming chat request with the system prompt and the tools', async () => {
    const { p, requests } = provider([{ body: fixture('ollama/text.json') }])
    expect(p).toMatchObject({ id: 'ollama', model: DEFAULT_OLLAMA_MODEL })
    expect(p.textOnly).toBe(false)
    await ask(p)
    expect(requests[0]!.url).toBe('http://ollama:11434/api/chat')
    expect(requests[0]!.body).toEqual({
      model: 'llama3.2',
      stream: false,
      messages: [
        { role: 'system', content: 'You are the Acme assistant.' },
        { role: 'user', content: 'When are you open?' },
      ],
      tools: TOOL_SPECS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    })
  })

  it('returns text with usage, and strips <think> blocks', async () => {
    const { p } = provider([{ body: fixture('ollama/text.json') }, { body: fixture('ollama/think-tags.json') }])
    expect(await ask(p)).toEqual({ kind: 'text', text: 'Hello! How can I help you today?', usage: { inputTokens: 412, outputTokens: 11 } })
    expect(await ask(p)).toMatchObject({ kind: 'text', text: 'Hi! How can I help?' })
  })

  it('returns tool calls with generated ids, and parses string arguments', async () => {
    const stringArgs = fixture('ollama/tool-call.json')
    stringArgs.message.tool_calls = [{ id: 'call_7', function: { name: 'tag_conversation', arguments: '{"tags":["hours"]}' } }]
    const { p } = provider([{ body: fixture('ollama/tool-call.json') }, { body: stringArgs }])
    expect(await ask(p)).toEqual({
      kind: 'tool_calls',
      calls: [{ id: 'ollama-1-0', name: 'search_knowledge', input: { query: 'opening hours' } }],
      usage: { inputTokens: 655, outputTokens: 21 },
    })
    expect(await ask(p)).toMatchObject({ calls: [{ id: 'call_7', name: 'tag_conversation', input: { tags: ['hours'] } }] })
  })

  it('switches to text-only mode once when the model does not support tools', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { p, requests } = provider([
        { status: 400, body: fixture('ollama/no-tools.json') },
        { body: fixture('ollama/text.json') },
        { body: fixture('ollama/text.json') },
      ], 'gemma2:2b')
      expect(await ask(p)).toMatchObject({ kind: 'text', text: 'Hello! How can I help you today?' })
      expect(p.textOnly).toBe(true)
      expect(requests[0]!.body).toHaveProperty('tools')
      expect(requests[1]!.body).not.toHaveProperty('tools')
      await ask(p)
      expect(requests).toHaveLength(3)
      expect(requests[2]!.body).not.toHaveProperty('tools')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('[relay] ollama model "gemma2:2b" does not support tools; running in text-only mode')
    } finally { warn.mockRestore() }
  })

  it('maps failures to stable codes', async () => {
    const cases: Array<[Recorded, string]> = [
      [{ status: 404, body: fixture('ollama/model-not-found.json') }, 'ollama_model_not_found'],
      [{ status: 500, body: { error: 'llama runner process has terminated' } }, 'ollama_http_500'],
      [{ status: 400, body: { error: 'invalid message format' } }, 'ollama_http_400'],
      [{ throws: new TypeError('fetch failed') }, 'ollama_offline'],
    ]
    for (const [recorded, code] of cases) {
      const { p } = provider([recorded])
      const err = await ask(p).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe(code)
    }
    const { p } = provider([{ status: 404, body: fixture('ollama/model-not-found.json') }])
    await expect(ask(p)).rejects.toThrow('ollama_model_not_found: model "llama3.2" not found, try pulling it first')
  })

  it('rethrows an abort instead of reporting the server offline', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortError = new DOMException('This operation was aborted', 'AbortError')
    const { p } = provider([{ throws: abortError }])
    await expect(p.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], signal: controller.signal })).rejects.toBe(abortError)
  })

  it('uses the text-only prompt for the request without tools', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { p, requests } = provider([{ status: 400, body: fixture('ollama/no-tools.json') }, { body: fixture('ollama/text.json') }], 'gemma2:2b')
      await p.generate({ system: 'TOOLS PROMPT', textOnlySystem: 'TEXT PROMPT', messages: [{ role: 'user', content: 'hi' }], tools: TOOL_SPECS })
      expect(requests[0]!.body.messages[0]).toEqual({ role: 'system', content: 'TOOLS PROMPT' })
      expect(requests[1]!.body.messages[0]).toEqual({ role: 'system', content: 'TEXT PROMPT' })
    } finally { warn.mockRestore() }
  })
})

describe('toOllamaMessages', () => {
  it('maps assistant tool calls and tool results', () => {
    expect(toOllamaMessages('sys', [
      { role: 'user', content: 'hours?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'search_knowledge', input: { query: 'hours' } }], raw: { ignored: true } },
      { role: 'tool', toolCallId: 'a', name: 'search_knowledge', content: 'NO_RESULTS' },
      { role: 'assistant', content: 'We open at 8:00.' },
    ])).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hours?' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_knowledge', arguments: { query: 'hours' } } }] },
      { role: 'tool', content: 'NO_RESULTS', tool_name: 'search_knowledge' },
      { role: 'assistant', content: 'We open at 8:00.' },
    ])
  })
})
