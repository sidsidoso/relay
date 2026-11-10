import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, type Contact, type Conversation, type ConversationSummary, type Filter, type Message, type User } from '../api'
import { connectLive } from '../live'
import { ConversationList } from '../components/ConversationList'
import { Timeline } from '../components/Timeline'

const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['waiting_human', 'Waiting for human'], ['mine', 'Mine'], ['closed', 'Closed']]

export function Inbox({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [items, setItems] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ conversation: Conversation; contact: Contact; messages: Message[] } | null>(null)
  const [draft, setDraft] = useState('')
  const [replyError, setReplyError] = useState(false)
  const [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState(false)

  // Refs keep one socket for the whole session and let async responses check they are still current.
  const selectedRef = useRef(selectedId)
  const filterRef = useRef(filter)
  const onLogoutRef = useRef(onLogout)
  selectedRef.current = selectedId
  filterRef.current = filter
  onLogoutRef.current = onLogout

  // Returns true when the error was a 401 (session expired) and the user was sent back to login.
  const expired = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { onLogoutRef.current(); return true }
    return false
  }, [])

  const refreshList = useCallback(async () => {
    const wanted = filter
    try {
      const r = await api.list(wanted)
      if (filterRef.current === wanted) setItems(r.conversations)
    } catch (err) { expired(err) }
  }, [filter, expired])

  const refreshDetail = useCallback(async () => {
    const id = selectedId
    if (!id) return
    try {
      const d = await api.get(id)
      if (selectedRef.current === id) setDetail(d)
    } catch (err) { expired(err) }
  }, [selectedId, expired])

  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => { void refreshDetail() }, [refreshDetail])

  const refreshRef = useRef({ refreshList, refreshDetail })
  refreshRef.current = { refreshList, refreshDetail }

  useEffect(() => connectLive('/ws/inbox', (frame) => {
    void refreshRef.current.refreshList()
    const current = selectedRef.current
    if (frame.event === 'message.created' && frame.data.conversationId === current) {
      setDetail((d) => d && d.conversation.id === frame.data.conversationId && !d.messages.some((m) => m.id === frame.data.message.id)
        ? { ...d, messages: [...d.messages, frame.data.message] } : d)
    }
    if (frame.event === 'conversation.updated' && frame.data.conversation.id === current) {
      setDetail((d) => d && d.conversation.id === frame.data.conversation.id ? { ...d, conversation: frame.data.conversation } : d)
    }
  }, () => { void refreshRef.current.refreshList(); void refreshRef.current.refreshDetail() },
  (code) => { if (code === 4401) onLogoutRef.current() }).stop, [])

  function select(id: number) {
    if (id === selectedRef.current) return
    selectedRef.current = id
    setSelectedId(id)
    setDetail(null)
    setDraft('')
    setReplyError(false)
    setActionError(false)
  }

  async function act(fn: (id: number) => Promise<unknown>) {
    const id = selectedId
    if (!id || busy) return
    setBusy(true)
    setActionError(false)
    try {
      await fn(id)
    } catch (err) {
      if (!expired(err) && selectedRef.current === id) setActionError(true)
    }
    await Promise.all([refreshList(), refreshDetail()])
    setBusy(false)
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    const id = selectedId
    if (!id || !text) return
    setReplyError(false)
    try {
      const { message } = await api.reply(id, text)
      if (selectedRef.current !== id) return
      setDraft('')
      setDetail((d) => d && d.conversation.id === id && !d.messages.some((m) => m.id === message.id)
        ? { ...d, messages: [...d.messages, message] } : d)
    } catch (err) {
      if (!expired(err) && selectedRef.current === id) setReplyError(true)
    }
  }

  async function logout() {
    try { await api.logout() } catch { /* leave anyway */ }
    onLogout()
  }

  const conv = detail?.conversation
  return (
    <div className="inbox">
      <aside className="col-list">
        <header className="topbar">
          <strong>Relay</strong>
          <span>{user.name}</span>
          <button onClick={() => void logout()}>Sign out</button>
        </header>
        <nav className="filters">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={f === filter ? 'active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </nav>
        <ConversationList items={items} selectedId={selectedId} onSelect={select} />
      </aside>
      <main className="col-timeline">
        {!detail && <p className="empty">Select a conversation</p>}
        {detail && conv && (
          <>
            <header className="conv-header">
              <h2>{detail.contact.name ?? `Visitor #${conv.id}`}</h2>
              <div className="actions">
                {conv.assigneeId !== user.id && conv.status !== 'closed' && <button disabled={busy} onClick={() => act(api.assign)}>Assign to me</button>}
                {conv.assigneeId !== null && conv.status !== 'closed' && <button disabled={busy} onClick={() => act(api.handBack)}>Hand back to agent</button>}
                {conv.status !== 'closed' && <button disabled={busy} onClick={() => act(api.close)}>Close</button>}
              </div>
            </header>
            {actionError && <p role="alert" className="error">Action failed. Try again.</p>}
            {conv.handoffReason && <p className="handoff">Handoff: {conv.handoffReason}</p>}
            <Timeline messages={detail.messages} />
            {conv.status !== 'closed' && (
              <form className="reply" onSubmit={send}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Reply as the team…" />
                <button type="submit">Send</button>
                {replyError && <p role="alert" className="error">Could not send. Try again.</p>}
              </form>
            )}
          </>
        )}
      </main>
      <aside className="col-contact">
        {detail && (
          <>
            <h3>Contact</h3>
            <p>{detail.contact.name ?? 'Anonymous visitor'}</p>
            <p className="muted">Channel: {detail.contact.channel}</p>
            <h3>Tags</h3>
            <p className="muted">{conv?.tags.length ? conv.tags.join(', ') : 'None'}</p>
          </>
        )}
      </aside>
    </div>
  )
}
