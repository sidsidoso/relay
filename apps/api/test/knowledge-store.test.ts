import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore, KnowledgeError, seedKnowledge, MAX_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_FILES } from '../src/agent/knowledgeStore'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-kb-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('KnowledgeStore', () => {
  it('writes, lists, reads and removes files, and refreshes passages after each write', () => {
    const store = new KnowledgeStore(join(dir, 'kb'))
    expect(store.list()).toEqual([])
    expect(store.passages()).toEqual([])
    const file = store.write('hours.md', '# Hours\r\n\r\n## Weekdays\r\nOpen 8am to 8pm.\r\n')
    expect(file).toMatchObject({ name: 'hours.md', bytes: expect.any(Number) })
    expect(store.read('hours.md')).toBe('# Hours\n\n## Weekdays\nOpen 8am to 8pm.\n')
    expect(store.passages().map((p) => p.title)).toEqual(['Weekdays'])
    store.write('hours.md', '# Hours\n\n## Weekends\nClosed.\n')
    expect(store.passages().map((p) => p.title)).toEqual(['Weekends'])
    expect(store.list().map((f) => f.name)).toEqual(['hours.md'])
    expect(store.remove('hours.md')).toBe(true)
    expect(store.remove('hours.md')).toBe(false)
    expect(store.read('hours.md')).toBeNull()
    expect(store.passages()).toEqual([])
    expect(readdirSync(join(dir, 'kb'))).toEqual([]) // no temp files left behind
  })

  it('rejects names that could leave the folder or are not lowercase .md', () => {
    const store = new KnowledgeStore(dir)
    for (const bad of ['../x.md', 'a/b.md', 'Notes.md', 'x.txt', '.md', '-x.md', `${'a'.repeat(64)}.md`]) {
      expect(() => store.write(bad, 'x')).toThrow(KnowledgeError)
      expect(() => store.read(bad)).toThrow(KnowledgeError)
      expect(() => store.remove(bad)).toThrow(KnowledgeError)
    }
  })

  it('caps the file size and the number of files', () => {
    const store = new KnowledgeStore(dir)
    expect(() => store.write('big.md', 'x'.repeat(MAX_KNOWLEDGE_BYTES + 1))).toThrow(expect.objectContaining({ code: 'too_large' }))
    for (let i = 0; i < MAX_KNOWLEDGE_FILES; i++) writeFileSync(join(dir, `f${i}.md`), 'x')
    expect(() => store.write('one-more.md', 'x')).toThrow(expect.objectContaining({ code: 'too_many_files' }))
    expect(() => store.write('f0.md', 'still fine')).not.toThrow() // replacing an existing file is allowed
  })
})

describe('seedKnowledge', () => {
  it('copies the shipped files only into an empty folder', () => {
    const shipped = join(dir, 'shipped')
    const target = join(dir, 'data')
    new KnowledgeStore(shipped).write('acme.md', '# Acme\n\n## Prices\nCheap.\n')
    expect(seedKnowledge(target, shipped)).toBe(1)
    new KnowledgeStore(target).write('acme.md', '# Acme\n\n## Prices\nEdited.\n')
    expect(seedKnowledge(target, shipped)).toBe(0)
    expect(new KnowledgeStore(target).read('acme.md')).toContain('Edited.')
  })
})
