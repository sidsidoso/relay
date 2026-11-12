import { describe, it, expect, vi } from 'vitest'
import { OfflineRetry } from '../src/transcription/retry'
import type { TranscriberHealth } from '../src/transcription/client'

const up: TranscriberHealth = { ok: true, model: 'small', loaded: true, error: null }
const loading: TranscriberHealth = { ok: true, model: 'small', loaded: false, error: null }

/** health() answers each entry in turn and then keeps repeating the last one. */
function setup(answers: Array<TranscriberHealth | null>, intervalMs = 60_000) {
  const queue = [...answers]
  const transcriber = { health: vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)) }
  const reschedule = vi.fn()
  return { retry: new OfflineRetry(transcriber, reschedule, intervalMs), transcriber, reschedule }
}

describe('OfflineRetry', () => {
  it('reschedules every waiting conversation once the model is loaded', async () => {
    const { retry, reschedule } = setup([null, loading, up])
    retry.add(1)
    retry.add(2)
    retry.add(1)
    await retry.check()
    await retry.check()
    expect(reschedule).not.toHaveBeenCalled()
    await retry.check()
    expect(reschedule.mock.calls).toEqual([[1], [2]])
    expect(retry.size).toBe(0)
    retry.stop()
  })

  it('does not ask for health when nothing is waiting', async () => {
    const { retry, transcriber } = setup([up])
    await retry.check()
    expect(transcriber.health).not.toHaveBeenCalled()
  })

  it('polls on its own and stops polling when done', async () => {
    const { retry, transcriber, reschedule } = setup([up], 10)
    retry.add(7)
    await vi.waitFor(() => expect(reschedule).toHaveBeenCalledWith(7))
    const calls = transcriber.health.mock.calls.length
    await new Promise((r) => setTimeout(r, 40))
    expect(transcriber.health.mock.calls.length).toBe(calls)
  })

  it('stop() forgets the waiting conversations', async () => {
    const { retry, reschedule } = setup([up])
    retry.add(1)
    retry.stop()
    await retry.check()
    expect(reschedule).not.toHaveBeenCalled()
  })
})
