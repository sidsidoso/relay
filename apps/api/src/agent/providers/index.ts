import { DemoProvider } from './demo'
import type { Provider } from './types'

let warned = false

/** Plan 2 ships only the demo provider; Claude and Ollama are added in plan 3. */
export function selectProvider(env: NodeJS.ProcessEnv): Provider {
  const wanted = env.RELAY_PROVIDER
  if (wanted && wanted !== 'demo' && !warned) {
    warned = true
    console.warn(`[relay] provider "${wanted}" is not available yet; using the demo provider`)
  }
  return new DemoProvider()
}
