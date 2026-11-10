import { useEffect, useRef, useState, type FormEvent } from 'react'
import { connectLive, type Live } from '../live'

type WidgetMessage = { id: number; sender: 'contact' | 'agent' | 'user' | 'system'; type: 'text' | 'audio'; text: string | null }

const KEY = 'relay.visitor'

let memoryToken: string | null = null

function newToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function visitorToken(): string {
  try {
    let t = localStorage.getItem(KEY)
    if (!t || t.length < 32) { t = newToken(); localStorage.setItem(KEY, t) }
    return t
  } catch {
    return (memoryToken ??= newToken())
  }
}

export function Widget({ company }: { company: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<'connecting' | 'failed' | null>(null)
  const liveRef = useRef<Live | null>(null)

  useEffect(() => {
    if (!open) return
    const live = connectLive(`/ws/widget?token=${visitorToken()}`, (frame) => {
      if (frame.type === 'error') setNotice('failed')
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
    if (liveRef.current?.send(JSON.stringify({ type: 'text', text }))) { setDraft(''); setNotice(null) }
    else setNotice('connecting')
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
      {notice === 'connecting' && <p role="status" className="widget-notice">Connecting… try again in a moment.</p>}
      {notice === 'failed' && <p role="alert" className="widget-notice">Your message could not be sent.</p>}
    </section>
  )
}
