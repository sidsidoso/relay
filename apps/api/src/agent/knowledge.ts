import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Passage = { source: string; title: string; text: string }

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'is', 'do', 'does', 'what', 'how', 'can', 'of', 'to', 'in', 'on', 'it', 'an', 'or', 'me', 'my', 'we', 'our',
  'de', 'da', 'das', 'dos', 'que', 'em', 'um', 'uma', 'para', 'com', 'por', 'os', 'as', 'no', 'na', 'se', 'eu', 'voce',
])

export function tokenize(text: string): string[] {
  const plain = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  return (plain.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Every *.md file in `dir` (sorted), split into passages at `## ` headings. */
export function loadKnowledge(dir: string): Passage[] {
  if (!existsSync(dir)) return []
  const out: Passage[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const content = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n')
    const [head, ...sections] = content.split(/^## /m)
    const h1 = head!.match(/^# (.+)$/m)
    const intro = head!.replace(/^# .+$/m, '').trim()
    if (intro) out.push({ source: file, title: h1 ? h1[1]!.trim() : file.replace(/\.md$/, ''), text: intro })
    for (const section of sections) {
      const [titleLine, ...body] = section.split('\n')
      const text = body.join('\n').trim()
      if (text) out.push({ source: file, title: titleLine!.trim(), text })
    }
  }
  return out
}

/** BM25 (k1 = 1.2, b = 0.75) over title + text; only matching passages, best first. */
export function searchKnowledge(passages: Passage[], query: string, limit = 3): Passage[] {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || passages.length === 0) return []
  const docs = passages.map((p) => tokenize(`${p.title} ${p.text}`))
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.includes(t)).length]))
  const k1 = 1.2
  const b = 0.75
  return passages
    .map((p, i) => {
      const doc = docs[i]!
      let score = 0
      for (const t of terms) {
        const tf = doc.filter((x) => x === t).length
        if (tf === 0) continue
        const n = df.get(t)!
        const idf = Math.log(1 + (passages.length - n + 0.5) / (n + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen)))
      }
      return { p, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, limit)
    .map((x) => x.p)
}
