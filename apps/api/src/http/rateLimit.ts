import type { FastifyReply } from 'fastify'

/** Keys kept before expired windows are swept; bounds memory under a flood of distinct addresses. */
const SWEEP_AT = 10_000

/** Fixed-window counter per key, in memory: Relay runs as one API process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(readonly limit: number, readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one hit for `key`. Returns 0 when it is allowed, otherwise the ms until the window resets. */
  take(key: string): number {
    const t = this.now()
    let entry = this.hits.get(key)
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size >= SWEEP_AT) this.sweep(t)
      entry = { count: 0, resetAt: t + this.windowMs }
      this.hits.set(key, entry)
    }
    entry.count++
    return entry.count > this.limit ? entry.resetAt - t : 0
  }

  private sweep(t: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key)
  }
}

export type Limits = { login: RateLimiter; widgetMessages: RateLimiter; widgetAudio: RateLimiter }

/** Generous for people, tight for scripts: a public demo must survive someone looping on it. */
export function defaultLimits(): Limits {
  return {
    login: new RateLimiter(10, 5 * 60_000),
    widgetMessages: new RateLimiter(30, 60_000),
    widgetAudio: new RateLimiter(6, 60_000),
  }
}

export function tooManyRequests(reply: FastifyReply, waitMs: number) {
  return reply.code(429).header('retry-after', String(Math.ceil(waitMs / 1000)))
    .send({ error: 'Too many requests', code: 'rate_limited' })
}
