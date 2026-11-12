import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, type AgentRun, type Contact, type Conversation, type ConversationSummary, type Filter, type InboxFrame, type Message, type User } from '../api'
import { connectLive } from '../live'
import { mergeRefresh } from '../inboxList'
import { ConversationList } from '../components/ConversationList'
import { Timeline } from '../components/Timeline'
import { AgentActivity } from '../components/AgentActivity'

/** Live frames refresh the list at most once per this many ms (the agent roughly doubles event volume). */
const LIST_REFRESH_MS = 300

const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['waiting_human', 'Waiting for human'], ['mine', 'Mine'], ['closed', 'Closed']]

export function Inbox({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [items, setItems] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ conversation: Conversation; contact: Contact; messages: Message[] } | null>(null)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [draft, setDraft] = useState('')
  const [replyError, setReplyError] = useState(false)
  const [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)

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

  // A live refresh reloads at least as many rows as are loaded, so it does not drop pages the user opened.
  const itemsCountRef = useRef(0)
  itemsCountRef.current = items.length
  const itemsRef = useRef<ConversationSummary[]>([])
  itemsRef.current = items
  const nextCursorRef = useRef<string | null>(null)
  nextCursorRef.current = nextCursor
  const refreshList = useCallback(async () => {
    const wanted = filter
    try {
      const limit = Math.min(100, Math.max(50, itemsCountRef.current))
      const r = await api.list(wanted, limit > 50 ? { limit } : {})
      if (filterRef.current !== wanted) return
      const merged = mergeRefresh(itemsRef.current, nextCursorRef.current, r.conversations, r.nextCursor)
      setItems(merged.items)
      setNextCursor(merged.nextCursor)
    } catch (err) { expired(err) }
  }, [filter, expired])

  async function loadMore() {
    const wanted = filter
    if (!nextCursor) return
    try {
      const r = await api.list(wanted, { before: nextCursor })
      if (filterRef.current !== wanted) return
      setItems((xs) => [...xs, ...r.conversations.filter((c) => !xs.some((x) => x.id === c.id))])
      setNextCursor(r.nextCursor)
    } catch (err) { expired(err) }
  }

  const refreshDetail = useCallback(async () => {
    const id = selectedId
    if (!id) return
    try {
      const [d, r] = await Promise.all([
        api.get(id),
        // Runs are secondary: if they fail to load (other than 401) the conversation still opens.
        api.agentRuns(id).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) throw err
          return { runs: [] as AgentRun[] }
        }),
      ])
      if (selectedRef.current === id) { setDetail(d); setRuns(r.runs) }
    } catch (err) { expired(err) }
  }, [selectedId, expired])

  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => { void refreshDetail() }, [refreshDetail])

  const refreshRef = useRef({ refreshList, refreshDetail })
  refreshRef.current = { refreshList, refreshDetail }

  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (listTimer.current) clearTimeout(listTimer.current) }, [])
  const scheduleListRefresh = useCallback(() => {
    if (listTimer.current) return
    listTimer.current = setTimeout(() => {
      listTimer.current = null
      void refreshRef.current.refreshList()
    }, LIST_REFRESH_MS)
  }, [])

  useEffect(() => connectLive<InboxFrame>('/ws/inbox', (frame) => {
    scheduleListRefresh()
    const current = selectedRef.current
    if (frame.event === 'message.created' && frame.data.conversationId === current) {
      setDetail((d) => d && d.conversation.id === frame.data.conversationId && !d.messages.some((m) => m.id === frame.data.message.id)
        ? { ...d, messages: [...d.messages, frame.data.message] } : d)
    }
    if (frame.event === 'message.updated' && frame.data.conversationId === current) {
      const { message } = frame.data
      setDetail((d) => d && d.conversation.id === message.conversationId
        ? { ...d, messages: d.messages.map((m) => (m.id === message.id ? message : m)) } : d)
    }
    if (frame.event === 'conversation.updated' && frame.data.conversation.id === current) {
      const { conversation } = frame.data
      setDetail((d) => d && d.conversation.id === conversation.id ? { ...d, conversation } : d)
    }
    if (frame.event === 'agent.run.created' && frame.data.conversationId === current) {
      const { run } = frame.data
      setRuns((rs) => rs.some((x) => x.id === run.id) ? rs : [run, ...rs])
    }
  }, () => { void refreshRef.current.refreshList(); void refreshRef.current.refreshDetail() },
  (code) => { if (code === 4401) onLogoutRef.current() }).stop, [scheduleListRefresh])

  function select(id: number) {
    if (id === selectedRef.current) return
    selectedRef.current = id
    setSelectedId(id)
    setDetail(null)
    setRuns([])
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
    if (!id || !text || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setReplyError(false)
    try {
      const { message } = await api.reply(id, text)
      if (selectedRef.current !== id) return
      setDraft((d) => (d.trim() === text ? '' : d)) // keep anything typed while the reply was in flight
      setDetail((d) => d && d.conversation.id === id && !d.messages.some((m) => m.id === message.id)
        ? { ...d, messages: [...d.messages, message] } : d)
    } catch (err) {
      if (!expired(err) && selectedRef.current === id) setReplyError(true)
    } finally {
      sendingRef.current = false
      setSending(false)
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
          <a href="/settings">Settings</a>
          <span>{user.name}</span>
          <button onClick={() => void logout()}>Sign out</button>
        </header>
        <nav className="filters">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={f === filter ? 'active' : ''} aria-pressed={f === filter} onClick={() => { if (f !== filter) { setItems([]); setNextCursor(null); setFilter(f) } }}>{label}</button>
          ))}
        </nav>
        <ConversationList items={items} selectedId={selectedId} onSelect={select} />
        {nextCursor && <button className="load-more" onClick={() => void loadMore()}>Load more</button>}
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
                <input aria-label="Reply" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Reply as the team…" />
                <button type="submit" disabled={sending}>Send</button>
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
            <h3>Agent activity</h3>
            <AgentActivity runs={runs} />
          </>
        )}
      </aside>
    </div>
  )
}
