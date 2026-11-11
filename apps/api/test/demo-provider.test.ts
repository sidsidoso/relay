import { describe, it, expect, vi } from 'vitest'
import { DemoProvider } from '../src/agent/providers/demo'
import { selectProvider } from '../src/agent/providers'
import { TOOL_SPECS, NO_RESULTS } from '../src/agent/tools'
import type { ChatMessage } from '../src/agent/providers/types'

const p = new DemoProvider()
const run = (messages: ChatMessage[]) => p.generate({ system: 's', messages, tools: TOOL_SPECS })

describe('DemoProvider', () => {
  it('greets', async () => {
    expect(await run([{ role: 'user', content: 'Olá!' }])).toMatchObject({ kind: 'text', text: expect.stringMatching(/^Hi! I'm the Acme Coworking assistant/) })
    expect(await run([])).toMatchObject({ kind: 'text', text: expect.stringMatching(/^Hi!/) })
  })

  it('searches the knowledge base for a question', async () => {
    expect(await run([{ role: 'user', content: 'How much is a meeting room?' }])).toEqual({
      kind: 'tool_calls', calls: [{ id: 'demo-1', name: 'search_knowledge', input: { query: 'How much is a meeting room?' } }],
    })
  })

  it('a long message that starts with a greeting is still a question', async () => {
    expect(await run([{ role: 'user', content: 'Hi, how much is a meeting room for my team?' }])).toMatchObject({ kind: 'tool_calls' })
  })

  it('answers from the first passage after a search, cutting long text', async () => {
    const r = await run([
      { role: 'user', content: 'price?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'demo-1', name: 'search_knowledge', input: { query: 'price?' } }] },
      { role: 'tool', toolCallId: 'demo-1', name: 'search_knowledge', content: JSON.stringify([{ title: 'Plans and prices', text: 'Day pass: $25' }]) },
    ])
    expect(r).toEqual({ kind: 'text', text: 'Here is what I found about "Plans and prices":\n\nDay pass: $25' })
    const long = await run([{ role: 'tool', toolCallId: 'demo-1', name: 'search_knowledge', content: JSON.stringify([{ title: 'T', text: 'a'.repeat(700) }]) }])
    expect(long).toMatchObject({ kind: 'text', text: expect.stringMatching(/a{600}…$/) })
  })

  it('hands off when the search found nothing, or on a complaint', async () => {
    const none = await run([
      { role: 'user', content: 'quantum?' },
      { role: 'tool', toolCallId: 'demo-1', name: 'search_knowledge', content: NO_RESULTS },
    ])
    expect(none).toMatchObject({ kind: 'tool_calls', calls: [{ name: 'transfer_to_human', input: { reason: 'No answer in the knowledge base' } }] })
    const complaint = await run([{ role: 'user', content: 'Quero cancelar meu plano' }])
    expect(complaint).toMatchObject({ kind: 'tool_calls', calls: [{ name: 'transfer_to_human' }] })
  })

  it('selectProvider falls back to demo and warns once for an unknown provider', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(selectProvider({}).id).toBe('demo')
      expect(selectProvider({ RELAY_PROVIDER: 'claude' }).id).toBe('demo')
      selectProvider({ RELAY_PROVIDER: 'claude' })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally { warn.mockRestore() }
  })

  it('TOOL_SPECS declares exactly the three tools', () => {
    expect(TOOL_SPECS.map((t) => t.name)).toEqual(['search_knowledge', 'transfer_to_human', 'tag_conversation'])
  })
})
