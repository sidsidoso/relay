import { readFileSync } from 'node:fs'
import type { FetchLike } from '../src/agent/providers/types'

export type Recorded = { status?: number; body?: unknown; throws?: Error }

/** Replays recorded HTTP responses in order and records every request. Tests never reach the network. */
export function fakeFetch(responses: Recorded[]) {
  const queue = [...responses]
  const requests: Array<{ url: string; body: any }> = []
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request to ${url}`)
    if (next.throws) throw next.throws
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, requests }
}

export const fixture = (path: string): any =>
  JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'))
