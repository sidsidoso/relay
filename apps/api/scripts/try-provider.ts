/**
 * Runs one full agent turn with the provider selected from the environment and prints the result.
 * With a key or a running Ollama it makes real requests; it is never part of the test suite.
 *   ANTHROPIC_API_KEY=... npm run try-provider -w apps/api -- "How much is a meeting room?"
 */
import { fileURLToPath } from 'node:url'
import { tryProvider } from '../src/agent/tryProvider'

const question = process.argv.slice(2).join(' ').trim() || 'How much is a meeting room?'
const knowledgeDir = process.env.RELAY_KNOWLEDGE_DIR?.trim() || fileURLToPath(new URL('../knowledge', import.meta.url))
const r = await tryProvider(process.env, question, { knowledgeDir })
const tokens = r.inputTokens !== null && r.outputTokens !== null ? `, ${r.inputTokens}/${r.outputTokens} tokens` : ''
console.log(`provider: ${r.provider} (${r.model ?? 'n/a'})`)
console.log(`outcome: ${r.outcome}${r.error ? ` (${r.error})` : ''}, ${r.durationMs} ms${tokens}`)
if (r.reply) console.log(`\n${r.reply}`)
process.exitCode = r.outcome === 'failed' ? 1 : 0
