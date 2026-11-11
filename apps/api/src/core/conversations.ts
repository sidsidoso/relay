import { and, desc, eq, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { contacts, conversations, messages, users } from '../db/schema'
import type { EventBus } from './events'
import type { ChannelId, ChannelRegistry, InboundMessage } from '../channels/types'
import type { Contact, Conversation, ConversationSummary, Message } from './types'

export type CoreDeps = { db: Db; bus: EventBus; channels: ChannelRegistry }

export class NotFoundError extends Error {
  constructor(what: string) { super(`${what} not found`) }
}

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
  const contact = findOrCreateContact(deps.db, msg)
  const existing = currentConversation(deps.db, contact.id)
  const conv = existing ?? deps.db.insert(conversations).values({
    contactId: contact.id, channel: msg.channel, status: 'open', createdAt: now(), updatedAt: now(),
  }).returning().get()
  const message = deps.db.insert(messages).values({
    conversationId: conv.id, sender: 'contact', type: msg.type, text: msg.text ?? null,
    mediaPath: msg.mediaPath ?? null, mediaMime: msg.mediaMime ?? null, createdAt: now(),
  }).returning().get()
  deps.bus.emit('message.created', { conversationId: conv.id, message })
  const conversation = touch(deps, conv.id)
  return { conversation, message }
}

export function listConversations(
  deps: CoreDeps, filter: { status?: Conversation['status']; assigneeId?: number },
): ConversationSummary[] {
  const where = and(
    filter.status ? eq(conversations.status, filter.status) : undefined,
    filter.assigneeId !== undefined ? eq(conversations.assigneeId, filter.assigneeId) : undefined,
  )
  const lastMessage = sql<string | null>`(
    SELECT coalesce(m.text, '[audio]') FROM messages m
    WHERE m.conversation_id = ${conversations.id} ORDER BY m.id DESC LIMIT 1)`
  return deps.db.select({
    conversation: conversations, contactName: contacts.name, assigneeName: users.name, lastMessage,
  }).from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(users, eq(users.id, conversations.assigneeId))
    .where(where)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .all()
    .map((r) => ({ ...r.conversation, contactName: r.contactName, assigneeName: r.assigneeName, lastMessage: r.lastMessage }))
}

export function getConversation(deps: CoreDeps, id: number) {
  const conversation = deps.db.select().from(conversations).where(eq(conversations.id, id)).get()
  if (!conversation) return null
  const contact = deps.db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get()!
  const list = deps.db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.id).all()
  return { conversation, contact, messages: list }
}

export function assign(deps: CoreDeps, id: number, userId: number): Conversation {
  return touch(deps, id, { assigneeId: userId, status: 'open' })
}

export function handBack(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { assigneeId: null, status: 'open', handoffReason: null })
}

export function close(deps: CoreDeps, id: number): Conversation {
  return touch(deps, id, { status: 'closed' })
}

export async function teamReply(deps: CoreDeps, id: number, userId: number, text: string): Promise<Message> {
  const found = getConversation(deps, id)
  if (!found) throw new NotFoundError('Conversation')
  const message = deps.db.insert(messages).values({
    conversationId: id, sender: 'user', userId, type: 'text', text, createdAt: now(),
  }).returning().get()
  deps.bus.emit('message.created', { conversationId: id, message })
  const conversation = touch(deps, id)
  await deps.channels.get(conversation.channel)?.send({ conversation, contact: found.contact }, message)
  return message
}

export function historyForContact(deps: CoreDeps, channel: ChannelId, contactKey: string): Message[] {
  const contact = deps.db.select().from(contacts)
    .where(and(eq(contacts.channel, channel), eq(contacts.contactKey, contactKey))).get()
  if (!contact) return []
  const conv = currentConversation(deps.db, contact.id)
  if (!conv) return []
  return deps.db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(messages.id).all()
}
