import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { tryProvider } from '../src/agent/tryProvider'
import { SEARCH_RULE } from '../src/agent/engine'
import { fakeFetch, fixture } from './fake-fetch'

const knowledgeDir = fileURLToPath(new URL('../knowledge', import.meta.url))

describe('tryProvider', () => {
  it('runs a full turn on the demo provider with no configuration', async () => {
    const r = await tryProvider({}, 'What are your opening hours?', { knowledgeDir })
    expect(r).toMatchObject({ provider: 'demo', model: 'scripted', outcome: 'replied', error: null })
    expect(r.reply).toMatch(/^Here is what I found about/)
  })

  it('runs Claude with the app prompt and tools, over recorded responses', async () => {
    const answer = fixture('claude/answer.json')
    const f = fakeFetch([{ body: fixture('claude/tool-use.json') }, { body: answer }])
    const r = await tryProvider({ ANTHROPIC_API_KEY: 'test-key' }, 'How much is a meeting room?', { knowledgeDir, fetch: f.fetch })
    expect(r).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', outcome: 'replied', reply: answer.content[1].text, inputTokens: 912 + 1040 })
    expect(f.requests[0]!.body.system).toContain(SEARCH_RULE)
    expect(f.requests[0]!.body.tools.map((t: { name: string }) => t.name)).toContain('search_knowledge')
  })

  it('reports a provider failure with its stable code', async () => {
    const f = fakeFetch([
      { status: 401, body: fixture('claude/auth.json') },
    ])
    const r = await tryProvider({ ANTHROPIC_API_KEY: 'bad-key' }, 'Hello?', { knowledgeDir, fetch: f.fetch })
    expect(r.outcome).toBe('failed')
    expect(r.error).toMatch(/^claude_auth/)
  })
})
