import { useEffect, useRef, useState, type FormEvent } from 'react'
import { connectLive, type Live } from '../live'

type WidgetMessage = { id: number; sender: 'contact' | 'agent' | 'user' | 'system'; type: 'text' | 'audio'; text: string | null }

const KEY = 'relay.visitor'

export function visitorToken(): string {
  let t = localStorage.getItem(KEY)
  if (!t) { t = crypto.randomUUID(); localStorage.setItem(KEY, t) }
  return t
}

export function Widget({ company }: { company: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [draft, setDraft] = useState('')
  const liveRef = useRef<Live | null>(null)

  useEffect(() => {
    if (!open) return
    const live = connectLive(`/ws/widget?token=${visitorToken()}`, (frame) => {
      if (frame.type === 'history') setMessages(frame.messages)
      if (frame.type === 'message') setMessages((m) => m.some((x) => x.id === frame.message.id) ? m : [...m, frame.message])
    })
    liveRef.current = live
    return () => { live.stop(); liveRef.current = null }
  }, [open])

  function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (liveRef.current?.send(JSON.stringify({ type: 'text', text }))) setDraft('')
  }

  if (!open) return <button className="widget-launcher" onClick={() => setOpen(true)}>Chat with us</button>

  return (
    <section className="widget">
      <header className="widget-head">
        <strong>{company}</strong>
        <button aria-label="Close chat" onClick={() => setOpen(false)}>×</button>
      </header>
      <ol className="widget-body">
        {messages.map((m) => (
          <li key={m.id} className={m.sender === 'contact' ? 'w-msg w-me' : 'w-msg w-them'}>
            {m.type === 'audio' ? '[audio]' : m.text}
          </li>
        ))}
      </ol>
      <form aria-label="Chat" className="widget-form" onSubmit={send}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" />
        <button type="submit">Send</button>
      </form>
    </section>
  )
}
