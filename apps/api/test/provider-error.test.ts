import { describe, it, expect } from 'vitest'
import { ProviderError } from '../src/agent/providers/errors'

describe('ProviderError', () => {
  it('starts its message with the stable code', () => {
    const e = new ProviderError('claude_rate_limited', 'slow down')
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ name: 'ProviderError', code: 'claude_rate_limited', message: 'claude_rate_limited: slow down' })
    expect(new ProviderError('ollama_offline').message).toBe('ollama_offline')
    expect(new ProviderError('ollama_offline', '').message).toBe('ollama_offline')
  })
})
