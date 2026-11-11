import { vi } from 'vitest'
import { canRecord, startRecording, MAX_RECORDING_MS } from '../src/recorder'

class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus'
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable?: (e: { data: Blob }) => void
  onstop?: () => void
  constructor(public stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? ''
    FakeRecorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['opus'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

const track = { stop: vi.fn() }
const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))

beforeEach(() => {
  FakeRecorder.instances = []
  track.stop.mockClear()
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('recorder', () => {
  it('can record only with MediaRecorder and a microphone API', () => {
    expect(canRecord()).toBe(true)
    vi.stubGlobal('MediaRecorder', undefined)
    expect(canRecord()).toBe(false)
  })

  it('records opus in WebM and releases the microphone when stopped', async () => {
    const rec = await startRecording()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(FakeRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
    rec.stop()
    const blob = await rec.done
    expect(blob?.type).toBe('audio/webm;codecs=opus')
    expect(blob?.size).toBe(4)
    expect(track.stop).toHaveBeenCalled()
  })

  it('cancel() resolves with null and releases the microphone', async () => {
    const rec = await startRecording()
    rec.cancel()
    expect(await rec.done).toBeNull()
    expect(track.stop).toHaveBeenCalled()
  })

  it('stops by itself at the time limit', async () => {
    vi.useFakeTimers()
    const rec = await startRecording()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    expect(await rec.done).not.toBeNull()
  })
})
