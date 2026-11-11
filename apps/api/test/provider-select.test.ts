import { describe, it, expect, vi, afterEach } from 'vitest'
import { selectProvider, agentTimeoutMs } from '../src/agent/providers'
import { DEFAULT_TIMEOUT_MS } from '../src/agent/engine'

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
afterEach(() => warn.mockClear())

describe('selectProvider', () => {
  it('defaults to the demo provider', () => {
    expect(selectProvider({})).toMatchObject({ id: 'demo', model: 'scripted' })
  })

  it('auto-selects Claude when there is a key, then Ollama when there is a URL', () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ id: 'claude', model: 'claude-sonnet-5-5' })
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k', RELAY_CLAUDE_MODEL: ' claude-opus-5-5 ' })).toMatchObject({ id: 'claude', model: 'claude-opus-5-5' })
    expect(selectProvider({ OLLAMA_URL: 'http://ollama:11434' })).toMatchObject({ id: 'ollama', model: 'llama3.2' })
    expect(selectProvider({ OLLAMA_URL: 'http://ollama:11434', RELAY_OLLAMA_MODEL: 'qwen3:4b' })).toMatchObject({ id: 'ollama', model: 'qwen3:4b' })
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k', OLLAMA_URL: 'http://ollama:11434' }).id).toBe('claude')
  })

  it('treats empty or blank variables as unset (Docker Compose passes empty strings)', () => {
    expect(selectProvider({ RELAY_PROVIDER: '', ANTHROPIC_API_KEY: '  ', OLLAMA_URL: '' }).id).toBe('demo')
    expect(selectProvider({ ANTHROPIC_API_KEY: 'k', RELAY_CLAUDE_MODEL: '' }).model).toBe('claude-sonnet-5-5')
  })

  it('RELAY_PROVIDER wins, case-insensitively', () => {
    const both = { ANTHROPIC_API_KEY: 'k', OLLAMA_URL: 'http://ollama:11434' }
    expect(selectProvider({ ...both, RELAY_PROVIDER: 'ollama' }).id).toBe('ollama')
    expect(selectProvider({ ...both, RELAY_PROVIDER: 'Demo' }).id).toBe('demo')
    expect(selectProvider({ ...both, RELAY_PROVIDER: 'CLAUDE' }).id).toBe('claude')
  })

  it('RELAY_PROVIDER=ollama without a URL uses the local default', async () => {
    const calls: string[] = []
    const p = selectProvider({ RELAY_PROVIDER: 'ollama' }, {
      fetch: async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true })) },
    })
    await p.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] })
    expect(calls).toEqual(['http://localhost:11434/api/chat'])
  })

  it('RELAY_PROVIDER=claude without a key falls back to demo and warns once', () => {
    expect(selectProvider({ RELAY_PROVIDER: 'claude' }).id).toBe('demo')
    selectProvider({ RELAY_PROVIDER: 'claude' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[relay] RELAY_PROVIDER=claude needs ANTHROPIC_API_KEY; using the demo provider')
  })

  it('an unknown RELAY_PROVIDER falls back to demo and warns once', () => {
    expect(selectProvider({ RELAY_PROVIDER: 'gpt' }).id).toBe('demo')
    selectProvider({ RELAY_PROVIDER: 'gpt' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[relay] unknown RELAY_PROVIDER "gpt"; using the demo provider')
  })
})

describe('agentTimeoutMs', () => {
  it('uses RELAY_AGENT_TIMEOUT_MS when valid, else a per-provider default', () => {
    const demo = selectProvider({})
    const ollama = selectProvider({ OLLAMA_URL: 'http://ollama:11434' })
    expect(agentTimeoutMs({}, demo)).toBe(DEFAULT_TIMEOUT_MS)
    expect(agentTimeoutMs({}, ollama)).toBe(120_000)
    expect(agentTimeoutMs({ RELAY_AGENT_TIMEOUT_MS: '45000' }, ollama)).toBe(45_000)
    for (const bad of ['', 'abc', '-5', '0', '1.5']) expect(agentTimeoutMs({ RELAY_AGENT_TIMEOUT_MS: bad }, demo)).toBe(DEFAULT_TIMEOUT_MS)
  })
})
