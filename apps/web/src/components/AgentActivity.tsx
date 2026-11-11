import type { AgentRun } from '../api'

const OUTCOME = { replied: 'Replied', transferred: 'Handed off', failed: 'Failed' } as const

export function AgentActivity({ runs }: { runs: AgentRun[] }) {
  if (runs.length === 0) return <p className="muted">No agent activity yet</p>
  return (
    <ol className="runs">
      {runs.map((r) => (
        <li key={r.id} className={`run run-${r.outcome}`}>
          <strong>{OUTCOME[r.outcome]}</strong>
          <span>{r.model ? `${r.provider} · ${r.model}` : r.provider}</span>
          <span>{r.durationMs} ms</span>
          {r.inputTokens !== null && r.outputTokens !== null && <span>{r.inputTokens}/{r.outputTokens} tokens</span>}
          {r.error && <span className="run-error">{r.error}</span>}
          <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleTimeString()}</time>
        </li>
      ))}
    </ol>
  )
}
