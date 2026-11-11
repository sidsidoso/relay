import { EventEmitter } from 'node:events'
import type { AgentRun, Conversation, Message } from './types'

export type RelayEvents = {
  'message.created': { conversationId: number; message: Message }
  'conversation.updated': { conversation: Conversation }
  'agent.run.created': { conversationId: number; run: AgentRun }
}

type Listener<K extends keyof RelayEvents> = (data: RelayEvents[K]) => void

/** Listener failures (sync throws or async rejections) are logged and never reach the emitter. */
export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0)
  private wrappers = new Map<keyof RelayEvents, Map<Listener<any>, Listener<any>>>()

  on<K extends keyof RelayEvents>(event: K, fn: Listener<K>): void {
    const fail = (err: unknown) => console.error('[relay] event listener failed', event, err)
    const wrapper: Listener<K> = (data) => {
      try {
        const result = fn(data) as unknown
        if (result instanceof Promise) result.catch(fail)
      } catch (err) {
        fail(err)
      }
    }
    let byFn = this.wrappers.get(event)
    if (!byFn) this.wrappers.set(event, (byFn = new Map()))
    byFn.set(fn, wrapper)
    this.emitter.on(event, wrapper)
  }

  off<K extends keyof RelayEvents>(event: K, fn: Listener<K>): void {
    const wrapper = this.wrappers.get(event)?.get(fn)
    if (!wrapper) return
    this.wrappers.get(event)!.delete(fn)
    this.emitter.off(event, wrapper)
  }

  emit<K extends keyof RelayEvents>(event: K, data: RelayEvents[K]): void { this.emitter.emit(event, data) }
}
