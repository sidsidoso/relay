import type { Transcriber } from './client'

export const RETRY_INTERVAL_MS = 15_000

/**
 * Spec §5: when the transcriber is offline, nothing is stored and the audio is retried when it comes back.
 * Polls /health while some conversation is waiting; once the model is loaded, reschedules each waiting conversation once.
 */
export class OfflineRetry {
  private readonly waiting = new Set<number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private checking = false

  constructor(
    private readonly transcriber: Pick<Transcriber, 'health'>,
    private readonly reschedule: (conversationId: number) => void,
    private readonly intervalMs = RETRY_INTERVAL_MS,
  ) {}

  get size(): number {
    return this.waiting.size
  }

  add(conversationId: number): void {
    this.waiting.add(conversationId)
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), this.intervalMs)
    this.timer.unref?.()
  }

  async check(): Promise<void> {
    if (this.checking || this.waiting.size === 0) return
    this.checking = true
    try {
      const health = await this.transcriber.health()
      if (!health?.loaded) return
      const ids = [...this.waiting]
      this.stop()
      for (const id of ids) this.reschedule(id)
    } finally {
      this.checking = false
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.waiting.clear()
  }
}
