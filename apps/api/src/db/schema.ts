import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  expiresAt: text('expires_at').notNull(),
})

export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull(),
  contactKey: text('contact_key').notNull(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
}, (t) => [uniqueIndex('contacts_channel_key').on(t.channel, t.contactKey)])

export const conversations = sqliteTable('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  contactId: integer('contact_id').notNull().references(() => contacts.id),
  channel: text('channel').notNull(),
  status: text('status', { enum: ['open', 'waiting_human', 'closed'] }).notNull(),
  assigneeId: integer('assignee_id').references(() => users.id),
  agentTurns: integer('agent_turns').notNull().default(0),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  handoffReason: text('handoff_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [index('conversations_updated').on(t.updatedAt)])

export type Transcription = {
  status: 'ok' | 'empty' | 'failed'
  text?: string
  error?: string
  model?: string
  at: string
}

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  sender: text('sender', { enum: ['contact', 'agent', 'user', 'system'] }).notNull(),
  userId: integer('user_id').references(() => users.id),
  type: text('type', { enum: ['text', 'audio'] }).notNull(),
  text: text('text'),
  mediaPath: text('media_path'),
  mediaMime: text('media_mime'),
  transcription: text('transcription', { mode: 'json' }).$type<Transcription | null>(),
  createdAt: text('created_at').notNull(),
}, (t) => [index('messages_conversation').on(t.conversationId, t.createdAt)])

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id),
  provider: text('provider').notNull(),
  model: text('model'),
  durationMs: integer('duration_ms').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  outcome: text('outcome', { enum: ['replied', 'transferred', 'failed'] }).notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
})
