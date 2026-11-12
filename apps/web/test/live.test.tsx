import { vi } from 'vitest'
import { connectLive } from '../src/live'

class FakeWs {
  static made: FakeWs[] = []
  readyState = 0
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number }) => void
  constructor(public url: string) { FakeWs.made.push(this) }
  send() {}
  close() {}
}

beforeEach(() => { FakeWs.made = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWs) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('reconnects after a normal close but not after 4403 (forbidden origin)', () => {
  const live = connectLive('/ws/widget?token=t', () => {})
  FakeWs.made[0]!.onclose?.({ code: 1006 })
  vi.advanceTimersByTime(1000)
  expect(FakeWs.made).toHaveLength(2)
  FakeWs.made[1]!.onclose?.({ code: 4403 })
  vi.advanceTimersByTime(20_000)
  expect(FakeWs.made).toHaveLength(2)
  live.stop()
})
