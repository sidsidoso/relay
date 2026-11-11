import { DEFAULT_TIMEOUT_MS } from '../engine'
import { ClaudeProvider } from './claude'
import { DemoProvider } from './demo'
import { DEFAULT_OLLAMA_URL, OllamaProvider } from './ollama'
import type { FetchLike, Provider } from './types'

/** Local models are slower, especially on CPU and on the first request that loads the model. */
export const OLLAMA_TIMEOUT_MS = 120_000

const warned = new Set<string>()
function warnOnce(message: string) {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

/** Docker Compose passes unset variables as empty strings: treat blank as unset. */
const read = (env: NodeJS.ProcessEnv, key: string) => env[key]?.trim() || undefined

/** Spec §4: RELAY_PROVIDER if set; otherwise Claude if there is a key, then Ollama if there is a URL, then demo. */
export function selectProvider(env: NodeJS.ProcessEnv, opts: { fetch?: FetchLike } = {}): Provider {
  const apiKey = read(env, 'ANTHROPIC_API_KEY')
  const ollamaUrl = read(env, 'OLLAMA_URL')
  const claude = (key: string) => new ClaudeProvider({ apiKey: key, model: read(env, 'RELAY_CLAUDE_MODEL'), fetch: opts.fetch })
  const ollama = (url: string) => new OllamaProvider({ url, model: read(env, 'RELAY_OLLAMA_MODEL'), fetch: opts.fetch })

  const wanted = read(env, 'RELAY_PROVIDER')?.toLowerCase()
  if (wanted === 'demo') return new DemoProvider()
  if (wanted === 'claude') {
    if (apiKey) return claude(apiKey)
    warnOnce('[relay] RELAY_PROVIDER=claude needs ANTHROPIC_API_KEY; using the demo provider')
    return new DemoProvider()
  }
  if (wanted === 'ollama') return ollama(ollamaUrl ?? DEFAULT_OLLAMA_URL)
  if (wanted) {
    warnOnce(`[relay] unknown RELAY_PROVIDER "${wanted}"; using the demo provider`)
    return new DemoProvider()
  }
  if (apiKey) return claude(apiKey)
  if (ollamaUrl) return ollama(ollamaUrl)
  return new DemoProvider()
}

export function agentTimeoutMs(env: NodeJS.ProcessEnv, provider: Provider): number {
  const raw = read(env, 'RELAY_AGENT_TIMEOUT_MS')
  const n = raw === undefined ? NaN : Number(raw)
  if (Number.isInteger(n) && n > 0) return n
  return provider.id === 'ollama' ? OLLAMA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}
