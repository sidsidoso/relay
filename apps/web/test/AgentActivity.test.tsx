import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { AgentActivity } from '../src/components/AgentActivity'
import type { AgentRun } from '../src/api'

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 1, conversationId: 1, provider: 'demo', model: 'scripted', durationMs: 12, inputTokens: null, outputTokens: null,
  outcome: 'replied', error: null, createdAt: '2026-11-10T12:00:00Z', ...over,
})

describe('AgentActivity', () => {
  it('shows an empty state', () => {
    render(<AgentActivity runs={[]} />)
    expect(screen.getByText('No agent activity yet')).toBeInTheDocument()
  })

  it('shows outcome, provider, duration, tokens and error', () => {
    render(<AgentActivity runs={[
      run({ id: 2, outcome: 'failed', error: 'timeout', provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 120, outputTokens: 40, durationMs: 30000 }),
      run({ id: 1, outcome: 'transferred' }),
    ]} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Handed off')).toBeInTheDocument()
    expect(screen.getByText('claude · claude-sonnet-5-5')).toBeInTheDocument()
    expect(screen.getByText('120/40 tokens')).toBeInTheDocument()
    expect(screen.getByText('timeout')).toBeInTheDocument()
    expect(screen.getByText('30000 ms')).toBeInTheDocument()
  })
})
