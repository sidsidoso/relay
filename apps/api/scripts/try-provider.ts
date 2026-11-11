/**
 * Sends one question to the provider selected from the environment and prints the raw result.
 * Manual check only (it calls the real API or a running Ollama); never part of the test suite.
 *   ANTHROPIC_API_KEY=... npm run try-provider -w apps/api -- "How much is a meeting room?"
 */
import { agentTimeoutMs, selectProvider } from '../src/agent/providers'
import { TOOL_SPECS } from '../src/agent/tools'

const question = process.argv.slice(2).join(' ').trim() || 'How much is a meeting room?'
const provider = selectProvider(process.env)
console.log(`provider: ${provider.id} (${provider.model ?? 'n/a'})`)
const started = Date.now()
const result = await provider.generate({
  system: 'You are the assistant of Acme Coworking, a fictional coworking space. Keep answers short.',
  messages: [{ role: 'user', content: question }],
  tools: TOOL_SPECS,
  signal: AbortSignal.timeout(agentTimeoutMs(process.env, provider)),
})
const { raw: _raw, ...shown } = result as typeof result & { raw?: unknown }
console.log(JSON.stringify(shown, null, 2))
console.log(`${Date.now() - started} ms`)
