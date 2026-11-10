import type { Message } from '../api'

const WHO = { contact: 'Customer', agent: 'AI agent', user: 'Team', system: 'System' } as const

export function Timeline({ messages }: { messages: Message[] }) {
  return (
    <ol className="timeline">
      {messages.map((m) => (
        <li key={m.id} className={`msg msg-${m.sender}`}>
          <span className="msg-who">{WHO[m.sender]}</span>
          {m.type === 'audio'
            ? <span className="msg-text">[audio]</span>
            : <span className="msg-text">{m.text}</span>}
          <time className="msg-time">{new Date(m.createdAt).toLocaleTimeString()}</time>
        </li>
      ))}
    </ol>
  )
}
