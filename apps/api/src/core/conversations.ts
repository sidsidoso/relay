import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { contacts, conversations, messages, users } from '../db/schema'
import type { EventBus } from './events'
import type { ChannelId, ChannelRegistry, InboundMessage } from '../channels/types'
import type { Contact, Conversation, ConversationSummary, Message } from './types'

export type CoreDeps = { db: Db; bus: EventBus; channels: ChannelRegistry }

export class NotFoundError extends Error {
  constructor(what: string) { super(`${what} not found`) }
}

export class ConflictError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export type OutboundInput = { sender: 'agent' | 'user' | 'system'; userId?: number; text: string }

const now = () => new Date().toISOString()

function findOrCreateContact(db: Db, msg: InboundMessage): Contact {
  const found = db.select().from(contacts)
    .where(and(eq(contacts.channel, msg.channel), eq(contacts.contactKey, msg.contactKey))).get()
  if (found) {
    if (msg.contactName && found.name !== msg.contactName) {
      return db.update(contacts).set({ name: msg.contactName }).where(eq(contacts.id, found.id)).returning().get()
    }
    return found
  }
  return db.insert(contacts).values({
    channel: msg.channel, contactKey: msg.contactKey, name: msg.contactName ?? null, createdAt: now(),
  }).returning().get()
}

function currentConversation(db: Db, contactId: number): Conversation | undefined {
  return db.select().from(conversations)
    .where(and(eq(conversations.contactId, contactId), ne(conversations.status, 'closed')))
    .orderBy(desc(conversations.id)).get()
}

function touch(deps: CoreDeps, id: number, changes: Partial<Conversation> = {}): Conversation {
  const updated = deps.db.update(conversations).set({ ...changes, updatedAt: now() })
    .where(eq(conversations.id, id)).returning().get()
  if (!updated) throw new NotFoundError('Conversation')
  deps.bus.emit('conversation.updated', { conversation: updated })
  return updated
}

export function receiveInbound(deps: CoreDeps, msg: InboundMessage): { conversation: Conversation; message: Message } {
  // better-sqlite3 transactions are synchronous: no awaits and no bus events inside.
  const { conversation, message } = deps.db.transaction(() => {
    const contact = findOrCreateContact(deps.db, msg)
    const existing = currentConversation(deps.db, contact.id)
    const conv = existing ?? deps.db.insert(conversations).values({
      contactId: contact.id, channel: msg.channel, status: 'open', createdAt: now(), updatedAt: now(),
    }).returning().get()
    const message = deps.db.insert(messages).values({
      conversationId: conv.id, sender: 'contact', type: msg.type, text: msg.text ?? null,
      mediaPath: msg.mediaPath ?? null, mediaMime: msg.mediaMime ?? null, createdAt: now(),
    }).returning().get()
    const conversation = deps.db.update(conversations).set({ updatedAt: now() })
      .where(eq(conversations.id, conv.id)).returning().get()!
    return { conversation, message }
  })
  deps.bus.emit('message.created', { conversationId: conversation.id, message })
  deps.bus.emit('conversation.updated', { conversation })
  return { conversation, message }
}

export type Cursor = { updatedAt: string; id: number }
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url')
export function decodeCursor(s: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    return typeof v?.updatedAt === 'string' && Number.isInteger(v?.id) ? { updatedAt: v.updatedAt, id: v.id } : null
  } catch {
    return null
  }
}

export const DEFAULT_PAGE = 50

/** Newest first, `limit` per page; `before` continues after the last item of the previous page. */
export function listConversations(
  deps: CoreDeps,
  filter: { status?: Conversation['status']; assigneeId?: number },
  page: { limit?: number; before?: Cursor } = {},
): { conversations: ConversationSummary[]; nextCursor: string | null } {
  const limit = page.limit ?? DEFAULT_PAGE
  const where = and(
    filter.status ? eq(conversations.status, filter.status) : undefined,
    filter.assigneeId !== undefined ? eq(conversations.assigneeId, filter.assigneeId) : undefined,
    page.before
      ? or(lt(conversations.updatedAt, page.before.updatedAt),
        and(eq(conversations.updatedAt, page.before.updatedAt), lt(conversations.id, page.before.id)))
      : undefined,
  )
  const lastMessage = sql<string | null>`(
    SELECT coalesce(m.text, '[audio]') FROM messages m
    WHERE m.conversation_id = ${conversations.id} ORDER BY m.id DESC LIMIT 1)`
  const rows = deps.db.select({
    conversation: conversations, contactName: contacts.name, assigneeName: users.name, lastMessage,
  }).from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(users, eq(users.id, conversations.assigneeId))
    .where(where)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit + 1)
    .all()
    .map((r) => ({ ...r.conversation, contactName: r.contactName, assigneeName: r.assigneeName, lastMessage: r.lastMessage }))
  const more = rows.length > limit
  const items = more ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return { conversations: items, nextCursor: more && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null }
}

export function getConversation(deps: CoreDeps, id: number) {
  const conversation = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!conversation) return null
  const contact = deps.db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get()!
  const list = deps.db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.id).all()
  return { conversation, contact, messages: list }
}

export function assign(deps: CoreDeps, id: number, userId: number): Conversation {
  const current = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!current) throw new NotFoundError('Conversation')
  if (current.status === 'closed') throw new ConflictError('conversation_closed', 'Conversation is closed')
  return touch(deps, id, { assigneeId: userId, status: 'open' })
}

export function handBack(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { assigneeId: null, status: 'open', handoffReason: null, agentTurns: 0 })
}

export function close(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { status: 'closed' })
}

/**
 * The single outbound path (team, agent, system): stores the message and applies `changes` in one
 * transaction, emits, then delivers. A delivery failure is logged and never creates a duplicate.
 */
export async function postOutbound(
  deps: CoreDeps, id: number, input: OutboundInput, changes: Partial<Conversation> = {},
): Promise<Message> {
  const found = getConversation(deps, id)
  if (!found) throw new NotFoundError('Conversation')
  if (found.conversation.status === 'closed') throw new ConflictError('conversation_closed', 'Conversation is closed')
  const { message, conversation } = deps.db.transaction(() => {
    const message = deps.db.insert(messages).values({
      conversationId: id, sender: input.sender, userId: input.userId ?? null, type: 'text', text: input.text, createdAt: now(),
    }).returning().get()
    const conversation = deps.db.update(conversations).set({ ...changes, updatedAt: now() })
      .where(eq(conversations.id, id)).returning().get()!
    return { message, conversation }
  })
  deps.bus.emit('message.created', { conversationId: id, message })
  deps.bus.emit('conversation.updated', { conversation })
  try {
    await deps.channels.get(conversation.channel)?.send({ conversation, contact: found.contact }, message)
  } catch (err) {
    // The message is stored and visible in the inbox; a retry must not create a duplicate.
    console.error('[relay] delivery failed', conversation.channel, err)
  }
  return message
}

export function teamReply(deps: CoreDeps, id: number, userId: number, text: string): Promise<Message> {
  return postOutbound(deps, id, { sender: 'user', userId, text })
}

export function addTags(deps: CoreDeps, id: number, tags: string[]): Conversation {
  const current = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!current) throw new NotFoundError('Conversation')
  const merged = [...current.tags]
  for (const raw of tags) {
    const tag = String(raw).trim().toLowerCase()
    if (tag.length < 1 || tag.length > 30 || merged.includes(tag)) continue
    merged.push(tag)
  }
  return touch(deps, id, { tags: merged.slice(0, 10) })
}

export function historyForContact(deps: CoreDeps, channel: ChannelId, contactKey: string): Message[] {
  const contact = deps.db.select().from(contacts)
    .where(and(eq(contacts.channel, channel), eq(contacts.contactKey, contactKey))).get()
  if (!contact) return []
  const conv = currentConversation(deps.db, contact.id)
  if (!conv) return []
  return deps.db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(messages.id).all()
}
