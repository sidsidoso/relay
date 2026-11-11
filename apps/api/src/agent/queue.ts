import type { EventBus, RelayEvents } from '../core/events'

/** Runs agent turns one at a time per conversation; extra messages during a turn coalesce into one more turn. */
export class AgentQueue {
  private running = new Map<number, Promise<void>>()
  private again = new Set<number>()
  private readonly onMessage = ({ conversationId, message }: RelayEvents['message.created']) => {
    if (message.sender === 'contact') this.schedule(conversationId)
  }

  constructor(private readonly run: (conversationId: number) => Promise<unknown>, private readonly bus: EventBus) {}

  start(): void { this.bus.on('message.created', this.onMessage) }
  stop(): void { this.bus.off('message.created', this.onMessage) }

  schedule(conversationId: number): void {
    if (this.running.has(conversationId)) { this.again.add(conversationId); return }
    // Start on the next tick: never run a turn synchronously inside the emitter.
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        do {
          this.again.delete(conversationId)
          try {
            await this.run(conversationId)
          } catch (err) {
            console.error('[relay] agent turn crashed', conversationId, err)
          }
        } while (this.again.has(conversationId))
      })
      .finally(() => this.running.delete(conversationId))
    this.running.set(conversationId, task)
  }

  /** Resolves when nothing is running or scheduled. */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()])
  }
}
