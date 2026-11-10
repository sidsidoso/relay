import type { Contact, Conversation, Message } from '../core/types'

export type ChannelId = 'widget' | 'whatsapp'

export type InboundMessage = {
  channel: ChannelId
  contactKey: string
  contactName?: string
  type: 'text' | 'audio'
  text?: string
  mediaPath?: string
  mediaMime?: string
}

export interface Channel {
  id: ChannelId
  send(target: { conversation: Conversation; contact: Contact }, message: Message): Promise<void>
}

export class ChannelRegistry {
  private byId = new Map<string, Channel>()
  register(channel: Channel): void { this.byId.set(channel.id, channel) }
  get(id: string): Channel | undefined { return this.byId.get(id) }
}
