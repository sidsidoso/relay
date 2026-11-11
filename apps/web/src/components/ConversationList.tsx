import type { ConversationSummary } from '../api'

const STATUS_LABEL = { open: 'Open', waiting_human: 'Waiting for human', closed: 'Closed' } as const

export function ConversationList({ items, selectedId, onSelect }: {
  items: ConversationSummary[]; selectedId: number | null; onSelect: (id: number) => void
}) {
  if (items.length === 0) return <p className="empty">No conversations yet</p>
  return (
    <ul className="conv-list">
      {items.map((c) => (
        <li key={c.id}>
          <button className={c.id === selectedId ? 'conv selected' : 'conv'} onClick={() => onSelect(c.id)}>
            <span className="conv-name">{c.contactName ?? `Visitor #${c.id}`}</span>
            {c.status !== 'open' && <span className={`badge badge-${c.status}`}>{STATUS_LABEL[c.status]}</span>}
            <span className="conv-last">{c.lastMessage ?? ''}</span>
            {c.assigneeName && <span className="conv-assignee">{c.assigneeName}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
