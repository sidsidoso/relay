export type User = { id: number; email: string; name: string }
export type Status = 'open' | 'waiting_human' | 'closed'
export type Message = {
  id: number; conversationId: number; sender: 'contact' | 'agent' | 'user' | 'system'; userId: number | null
  type: 'text' | 'audio'; text: string | null; mediaPath: string | null; mediaMime: string | null
  transcription: { status: 'ok' | 'empty' | 'failed'; text?: string; error?: string; model?: string; durationS?: number } | null; createdAt: string
}
export type Conversation = {
  id: number; contactId: number; channel: string; status: Status; assigneeId: number | null; agentTurns: number
  tags: string[]; handoffReason: string | null; createdAt: string; updatedAt: string
}
export type ConversationSummary = Conversation & { contactName: string | null; lastMessage: string | null; assigneeName: string | null }
export type Contact = { id: number; channel: string; contactKey: string; name: string | null }
export type Filter = 'all' | 'waiting_human' | 'mine' | 'closed'
export type AgentRun = {
  id: number; conversationId: number; provider: string; model: string | null; durationMs: number
  inputTokens: number | null; outputTokens: number | null; outcome: 'replied' | 'transferred' | 'failed'; error: string | null; createdAt: string
}
export type InboxFrame =
  | { event: 'message.created'; data: { conversationId: number; message: Message } }
  | { event: 'message.updated'; data: { conversationId: number; message: Message } }
  | { event: 'conversation.updated'; data: { conversation: Conversation } }
  | { event: 'agent.run.created'; data: { conversationId: number; run: AgentRun } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, public fields: string[] = []) { super(code) }
}

export type Settings = { instructions: string; handoffKeywords: string[]; turnLimit: number; handoffMessage: string; transcriptionEnabled: boolean }
export type KnowledgeFile = { name: string; bytes: number; updatedAt: string }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error', Array.isArray(body.fields) ? body.fields : [])
  return body as T
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
const put = <T>(path: string, body: unknown) => call<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = (path: string) => call<void>(path, { method: 'DELETE' })

const FILTER_QUERY: Record<Filter, string> = { all: '', waiting_human: '?status=waiting_human', mine: '?mine=1', closed: '?status=closed' }

export const api = {
  me: () => call<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) => post<{ user: User }>('/api/auth/login', { email, password }),
  logout: () => post<void>('/api/auth/logout'),
  list: (filter: Filter, page: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams(FILTER_QUERY[filter].replace(/^\?/, ''))
    if (page.before) q.set('before', page.before)
    if (page.limit) q.set('limit', String(page.limit))
    const qs = q.toString()
    return call<{ conversations: ConversationSummary[]; nextCursor: string | null }>(`/api/conversations${qs ? `?${qs}` : ''}`)
  },
  get: (id: number) => call<{ conversation: Conversation; contact: Contact; messages: Message[] }>(`/api/conversations/${id}`),
  assign: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/assign`),
  handBack: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/hand-back`),
  close: (id: number) => post<{ conversation: Conversation }>(`/api/conversations/${id}/close`),
  reply: (id: number, text: string) => post<{ message: Message }>(`/api/conversations/${id}/messages`, { text }),
  agentRuns: (id: number) => call<{ runs: AgentRun[] }>(`/api/conversations/${id}/agent-runs`),
  settings: () => call<{ settings: Settings }>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) => put<{ settings: Settings }>('/api/settings', patch),
  knowledgeList: () => call<{ files: KnowledgeFile[] }>('/api/knowledge'),
  knowledgeFile: (name: string) => call<{ name: string; content: string }>(`/api/knowledge/${encodeURIComponent(name)}`),
  saveKnowledge: (name: string, content: string) => put<{ file: KnowledgeFile }>(`/api/knowledge/${encodeURIComponent(name)}`, { content }),
  deleteKnowledge: (name: string) => del(`/api/knowledge/${encodeURIComponent(name)}`),
}

/** The stored voice message, for the inbox audio player (cookie-authenticated). */
export const audioUrl = (conversationId: number, messageId: number) => `/api/conversations/${conversationId}/messages/${messageId}/audio`
