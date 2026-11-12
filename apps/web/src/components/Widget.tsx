import { useEffect, useRef, useState, type FormEvent } from 'react'
import { connectLive, type Live } from '../live'
import { canRecord, startRecording, type Recording } from '../recorder'

type WidgetMessage = { id: number; sender: 'contact' | 'agent' | 'user' | 'system'; type: 'text' | 'audio'; text: string | null; createdAt?: string }
type WidgetFrame = { type: 'history'; messages: WidgetMessage[] } | { type: 'message'; message: WidgetMessage } | { type: 'error'; code: string }
type Notice = 'connecting' | 'failed' | 'mic' | 'slow' | null

const KEY = 'relay.visitor'
const VISITOR_HEADER = 'X-Relay-Visitor'

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

/** The reconnect history and live frames can interleave: merge by id instead of replacing. */
export function mergeMessages(current: WidgetMessage[], incoming: WidgetMessage[]): WidgetMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

async function uploadAudio(blob: Blob): Promise<WidgetMessage | 'slow' | null> {
  try {
    const res = await fetch('/api/widget/audio', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', [VISITOR_HEADER]: visitorToken() },
      body: blob,
    })
    if (res.status === 429) return 'slow'
    if (!res.ok) return null
    return ((await res.json()) as { message: WidgetMessage }).message
  } catch {
    return null
  }
}

export function Widget({ company }: { company: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [recording, setRecording] = useState(false)
  const [sendingAudio, setSendingAudio] = useState(false)
  const liveRef = useRef<Live | null>(null)
  const recordingRef = useRef<Recording | null>(null)
  const bodyRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    if (!open) return
    const live = connectLive<WidgetFrame>(`/ws/widget?token=${visitorToken()}`, (frame) => {
      if (frame.type === 'error') setNotice(frame.code === 'rate_limited' ? 'slow' : 'failed')
      if (frame.type === 'history') setMessages((m) => mergeMessages(m, frame.messages))
      if (frame.type === 'message') setMessages((m) => mergeMessages(m, [frame.message]))
    })
    liveRef.current = live
    return () => { live.stop(); liveRef.current = null }
  }, [open])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => () => recordingRef.current?.cancel(), [])

  function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (liveRef.current?.send(JSON.stringify({ type: 'text', text }))) { setDraft(''); setNotice(null) }
    else setNotice('connecting')
  }

  async function toggleRecording() {
    if (recordingRef.current) { recordingRef.current.stop(); return }
    let rec: Recording
    try {
      rec = await startRecording()
    } catch {
      setNotice('mic')
      return
    }
    recordingRef.current = rec
    setRecording(true)
    setNotice(null)
    const blob = await rec.done
    recordingRef.current = null
    setRecording(false)
    if (!blob) return
    setSendingAudio(true)
    const result = await uploadAudio(blob)
    setSendingAudio(false)
    if (result === 'slow') setNotice('slow')
    else if (result) setMessages((m) => mergeMessages(m, [result]))
    else setNotice('failed')
  }

  function close() {
    recordingRef.current?.cancel()
    setOpen(false)
  }

  if (!open) return <button className="widget-launcher" onClick={() => setOpen(true)}>Chat with us</button>

  return (
    <section className="widget">
      <header className="widget-head">
        <strong>{company}</strong>
        <button type="button" aria-label="Close chat" onClick={close}>×</button>
      </header>
      <ol className="widget-body" ref={bodyRef} aria-live="polite">
        {messages.filter((m) => m.type === 'audio' || m.text).map((m) => (
          <li key={m.id} className={m.sender === 'contact' ? 'w-msg w-me' : 'w-msg w-them'}>
            {m.type === 'audio' ? <span className="w-audio">Voice message</span> : m.text}
          </li>
        ))}
      </ol>
      <form aria-label="Chat" className="widget-form" onSubmit={send}>
        <input aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" />
        {canRecord() && (
          <button
            type="button"
            className="w-voice"
            aria-pressed={recording}
            aria-label={recording ? 'Stop recording' : 'Record a voice message'}
            disabled={sendingAudio}
            onClick={() => void toggleRecording()}
          >
            {recording ? 'Stop' : 'Voice'}
          </button>
        )}
        <button type="submit">Send</button>
      </form>
      {notice === 'connecting' && <p role="status" className="widget-notice">Connecting… try again in a moment.</p>}
      {notice === 'failed' && <p role="alert" className="widget-notice">Your message could not be sent.</p>}
      {notice === 'slow' && <p role="alert" className="widget-notice">You are sending messages too fast. Wait a moment.</p>}
      {notice === 'mic' && <p role="alert" className="widget-notice">Microphone not available. Check the browser permission.</p>}
      {sendingAudio && <p role="status" className="widget-notice">Sending voice message…</p>}
    </section>
  )
}
