import type { contacts, conversations, messages } from '../db/schema'

export type Message = typeof messages.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type ConversationSummary = Conversation & {
  contactName: string | null
  lastMessage: string | null
  assigneeName: string | null
}
