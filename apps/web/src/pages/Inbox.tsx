import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Contact, type Conversation, type ConversationSummary, type Filter, type Message, type User } from '../api'
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

  const refreshList = useCallback(async () => setItems((await api.list(filter)).conversations), [filter])
  const refreshDetail = useCallback(async () => { if (selectedId) setDetail(await api.get(selectedId)) }, [selectedId])

  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => { void refreshDetail() }, [refreshDetail])

  // Refs keep one socket for the whole session: the handler always sees the current selection
  // and refresh functions without reconnecting when they change.
  const selectedRef = useRef(selectedId)
  const refreshRef = useRef({ refreshList, refreshDetail })
  selectedRef.current = selectedId
  refreshRef.current = { refreshList, refreshDetail }

  useEffect(() => connectLive('/ws/inbox', (frame) => {
    void refreshRef.current.refreshList()
    const current = selectedRef.current
    if (frame.event === 'message.created' && frame.data.conversationId === current) {
      setDetail((d) => d && !d.messages.some((m) => m.id === frame.data.message.id)
        ? { ...d, messages: [...d.messages, frame.data.message] } : d)
    }
    if (frame.event === 'conversation.updated' && frame.data.conversation.id === current) {
      setDetail((d) => d && { ...d, conversation: frame.data.conversation })
    }
  }, () => { void refreshRef.current.refreshList(); void refreshRef.current.refreshDetail() }).stop, [])

  async function act(fn: (id: number) => Promise<unknown>) {
    if (!selectedId) return
    await fn(selectedId)
    await Promise.all([refreshList(), refreshDetail()])
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!selectedId || !text) return
    setDraft('')
    await api.reply(selectedId, text)
  }

  const conv = detail?.conversation
  return (
    <div className="inbox">
      <aside className="col-list">
        <header className="topbar">
          <strong>Relay</strong>
          <span>{user.name}</span>
          <button onClick={async () => { await api.logout(); onLogout() }}>Sign out</button>
        </header>
        <nav className="filters">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={f === filter ? 'active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </nav>
        <ConversationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <main className="col-timeline">
        {!detail && <p className="empty">Select a conversation</p>}
        {detail && conv && (
          <>
            <header className="conv-header">
              <h2>{detail.contact.name ?? `Visitor #${conv.id}`}</h2>
              <div className="actions">
                {conv.assigneeId !== user.id && conv.status !== 'closed' && <button onClick={() => act(api.assign)}>Assign to me</button>}
                {conv.assigneeId !== null && conv.status !== 'closed' && <button onClick={() => act(api.handBack)}>Hand back to agent</button>}
                {conv.status !== 'closed' && <button onClick={() => act(api.close)}>Close</button>}
              </div>
            </header>
            {conv.handoffReason && <p className="handoff">Handoff: {conv.handoffReason}</p>}
            <Timeline messages={detail.messages} />
            {conv.status !== 'closed' && (
              <form className="reply" onSubmit={send}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Reply as the team…" />
                <button type="submit">Send</button>
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
