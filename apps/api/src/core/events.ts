import { EventEmitter } from 'node:events'
import type { Conversation, Message } from './types'

export type RelayEvents = {
  'message.created': { conversationId: number; message: Message }
  'conversation.updated': { conversation: Conversation }
}

export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0)
  on<K extends keyof RelayEvents>(event: K, fn: (data: RelayEvents[K]) => void): void { this.emitter.on(event, fn) }
  off<K extends keyof RelayEvents>(event: K, fn: (data: RelayEvents[K]) => void): void { this.emitter.off(event, fn) }
  emit<K extends keyof RelayEvents>(event: K, data: RelayEvents[K]): void { this.emitter.emit(event, data) }
}
