import { audioUrl, type Message } from '../api'

const WHO = { contact: 'Customer', agent: 'AI agent', user: 'Team', system: 'System' } as const

function Transcript({ t }: { t: Message['transcription'] }) {
  if (!t) return <span className="msg-transcript muted">Not transcribed yet</span>
  if (t.status === 'ok') return <p className="msg-transcript"><span className="muted">Transcription: </span>{t.text}</p>
  if (t.status === 'empty') return <span className="msg-transcript muted">No speech detected</span>
  return <span className="msg-transcript muted">{`Transcription failed${t.error ? ` (${t.error})` : ''}`}</span>
}

export function Timeline({ messages }: { messages: Message[] }) {
  return (
    <ol className="timeline">
      {messages.map((m) => (
        <li key={m.id} className={`msg msg-${m.sender}`}>
          <span className="msg-who">{WHO[m.sender]}</span>
          {m.type === 'audio'
            ? (
              <>
                <audio className="msg-audio" controls preload="none" src={audioUrl(m.conversationId, m.id)} aria-label="Voice message" />
                <Transcript t={m.transcription} />
              </>
            )
            : <span className="msg-text">{m.text}</span>}
          <time className="msg-time">{new Date(m.createdAt).toLocaleTimeString()}</time>
        </li>
      ))}
    </ol>
  )
}
