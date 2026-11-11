import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadKnowledge, searchKnowledge, tokenize } from '../src/agent/knowledge'

const SHIPPED = fileURLToPath(new URL('../knowledge', import.meta.url))

describe('knowledge base', () => {
  it('tokenize lowercases, strips accents and stopwords', () => {
    expect(tokenize('Qual é o PREÇO da sala de reunião?')).toEqual(['qual', 'preco', 'sala', 'reuniao'])
  })

  it('splits Markdown into passages by ## heading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-'))
    writeFileSync(join(dir, 'a.md'), '# Acme\nIntro line\n\n## Prices\nDesk is 25 a day\n\n## Hours\nOpen 8 to 20\n')
    const passages = loadKnowledge(dir)
    expect(passages.map((p) => p.title)).toEqual(['Acme', 'Prices', 'Hours'])
    expect(passages[1]).toEqual({ source: 'a.md', title: 'Prices', text: 'Desk is 25 a day' })
  })

  it('a missing directory is an empty knowledge base', () => {
    expect(loadKnowledge(join(tmpdir(), 'does-not-exist-relay'))).toEqual([])
  })

  it('finds the right passage in the shipped sample, best first', () => {
    const passages = loadKnowledge(SHIPPED)
    expect(searchKnowledge(passages, 'how much is a meeting room?')[0]!.title).toBe('Meeting rooms')
    expect(searchKnowledge(passages, 'what time do you open on saturday')[0]!.title).toBe('Opening hours')
    expect(searchKnowledge(passages, 'quantum entanglement')).toEqual([])
  })
})
