import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadKnowledge, type Passage } from './knowledge'

/** Lowercase letters, digits and dashes, ending in .md: no path separators, no hidden files. */
export const KNOWLEDGE_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.md$/
export const MAX_KNOWLEDGE_BYTES = 100 * 1024
export const MAX_KNOWLEDGE_FILES = 50

export class KnowledgeError extends Error {
  constructor(readonly code: 'invalid_name' | 'too_large' | 'too_many_files', message: string) { super(message) }
}

export type KnowledgeFile = { name: string; bytes: number; updatedAt: string }

function checkName(name: string): void {
  if (!KNOWLEDGE_NAME.test(name)) throw new KnowledgeError('invalid_name', 'Use lowercase letters, digits and dashes, ending in .md')
}

/** The Markdown knowledge base on disk (spec §7: data/knowledge), with passages cached until the next write. */
export class KnowledgeStore {
  private cache: Passage[] | null = null
  constructor(readonly dir: string) {}

  passages(): Passage[] {
    this.cache ??= loadKnowledge(this.dir)
    return this.cache
  }

  list(): KnowledgeFile[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter((f) => f.endsWith('.md')).sort().map((name) => this.info(name))
  }

  read(name: string): string | null {
    checkName(name)
    const file = join(this.dir, name)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }

  /** Atomic replace (temp file + rename); line endings are normalized to \n. */
  write(name: string, content: string): KnowledgeFile {
    checkName(name)
    const text = content.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(text, 'utf8') > MAX_KNOWLEDGE_BYTES) throw new KnowledgeError('too_large', `At most ${MAX_KNOWLEDGE_BYTES} bytes per file`)
    const file = join(this.dir, name)
    if (!existsSync(file) && this.list().length >= MAX_KNOWLEDGE_FILES) {
      throw new KnowledgeError('too_many_files', `At most ${MAX_KNOWLEDGE_FILES} files`)
    }
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `.${name}.${process.pid}.tmp`)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    this.cache = null
    return this.info(name)
  }

  remove(name: string): boolean {
    checkName(name)
    const file = join(this.dir, name)
    if (!existsSync(file)) return false
    rmSync(file)
    this.cache = null
    return true
  }

  private info(name: string): KnowledgeFile {
    const s = statSync(join(this.dir, name))
    return { name, bytes: s.size, updatedAt: s.mtime.toISOString() }
  }
}

/** First start: copy the shipped example files into the (empty) data folder so the demo has a knowledge base. */
export function seedKnowledge(dir: string, shippedDir: string): number {
  mkdirSync(dir, { recursive: true })
  if (readdirSync(dir).some((f) => f.endsWith('.md'))) return 0
  if (!existsSync(shippedDir)) return 0
  const files = readdirSync(shippedDir).filter((f) => f.endsWith('.md'))
  for (const f of files) copyFileSync(join(shippedDir, f), join(dir, f))
  return files.length
}
