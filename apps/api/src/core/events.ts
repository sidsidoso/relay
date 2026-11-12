import { EventEmitter } from 'node:events'
import type { AgentRun, Conversation, Message } from './types'

export type RelayEvents = {
  'message.created': { conversationId: number; message: Message }
  'message.updated': { conversationId: number; message: Message }
  'conversation.updated': { conversation: Conversation }
  'agent.run.created': { conversationId: number; run: AgentRun }
}

type Listener<K extends keyof RelayEvents> = (data: RelayEvents[K]) => void | Promise<void>

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'

/** Listener failures (sync throws or async rejections) are logged and never reach the emitter. */
export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0)
  private wrappers = new Map<keyof RelayEvents, Map<Listener<any>, Listener<any>>>()

  on<K extends keyof RelayEvents>(event: K, fn: Listener<K>): void {
    let byFn = this.wrappers.get(event)
    if (!byFn) this.wrappers.set(event, (byFn = new Map()))
    if (byFn.has(fn)) return // same listener twice would run twice and need two offs
    const fail = (err: unknown) => console.error('[relay] event listener failed', event, err)
    const wrapper: Listener<K> = (data) => {
      try {
        const result: unknown = fn(data)
        if (isThenable(result)) Promise.resolve(result).catch(fail)
      } catch (err) {
        fail(err)
      }
    }
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
