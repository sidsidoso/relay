import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
vi.mock('../src/recorder', () => ({ canRecord: vi.fn(() => true), startRecording: vi.fn(), MAX_RECORDING_MS: 120_000 }))
import { startRecording } from '../src/recorder'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Widget, visitorToken, mergeMessages } from '../src/components/Widget'

class FakeSocket {
  static last: FakeSocket
  sent: string[] = []
  readyState = 1
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number }) => void
  constructor(public url: string) { FakeSocket.last = this; setTimeout(() => this.onopen?.(), 0) }
  send(d: string) { this.sent.push(d) }
  close() {}
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

beforeEach(() => { localStorage.clear(); (globalThis as any).WebSocket = FakeSocket })
afterEach(() => vi.unstubAllGlobals())

describe('Widget', () => {
  it('keeps one visitor token per browser', () => {
    const a = visitorToken()
    expect(a).toMatch(/[0-9a-f-]{36}/)
    expect(visitorToken()).toBe(a)
  })

  it('opens, shows history and live messages, and sends text frames', async () => {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
    expect(FakeSocket.last.url).toContain(`/ws/widget?token=${visitorToken()}`)
    act(() => FakeSocket.last.emit({ type: 'history', messages: [{ id: 1, sender: 'contact', type: 'text', text: 'Earlier' }] }))
    expect(screen.getByText('Earlier')).toBeInTheDocument()
    act(() => FakeSocket.last.emit({ type: 'message', message: { id: 2, sender: 'user', type: 'text', text: 'Hello from the team' } }))
    expect(screen.getByText('Hello from the team')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/type a message/i), { target: { value: 'Price?' } })
    fireEvent.submit(screen.getByRole('form', { name: /chat/i }))
    expect(JSON.parse(FakeSocket.last.sent[0]!)).toEqual({ type: 'text', text: 'Price?' })
  })

  it('keeps the draft and shows a status when the socket is not ready', () => {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
    FakeSocket.last.readyState = 0
    const input = screen.getByPlaceholderText(/type a message/i)
    fireEvent.change(input, { target: { value: 'Hello?' } })
    fireEvent.submit(screen.getByRole('form', { name: /chat/i }))
    expect(input).toHaveValue('Hello?')
    expect(screen.getByRole('status')).toHaveTextContent('Connecting… try again in a moment.')
  })

  it('shows an alert on an error frame', () => {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
    act(() => FakeSocket.last.emit({ type: 'error', code: 'internal' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Your message could not be sent.')
  })

  it('still returns a long token when localStorage throws and randomUUID is missing', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const original = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    const t = visitorToken()
    expect(t.length).toBeGreaterThanOrEqual(32)
    expect(visitorToken()).toBe(t)
    Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
    get.mockRestore(); set.mockRestore()
  })

  function openWidget() {
    render(<Widget company="Acme Coworking" />)
    fireEvent.click(screen.getByRole('button', { name: /chat with us/i }))
  }

  function recordingThatStops(blob: Blob | null) {
    let finish!: (b: Blob | null) => void
    const done = new Promise<Blob | null>((resolve) => { finish = resolve })
    vi.mocked(startRecording).mockResolvedValue({ done, stop: vi.fn(() => finish(blob)), cancel: vi.fn(() => finish(null)) })
  }

  it('records a voice message and uploads it with the visitor token', async () => {
    recordingThatStops(new Blob(['opus'], { type: 'audio/webm;codecs=opus' }))
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ message: { id: 7, sender: 'contact', type: 'audio', text: null } }) }))
    vi.stubGlobal('fetch', fetchMock)
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stop recording/i }))
    expect(await screen.findByText('Voice message')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/widget/audio')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus', 'X-Relay-Visitor': visitorToken() } })
    expect(init.body).toBeInstanceOf(Blob)
  })

  it('shows an alert when the microphone is not available', async () => {
    vi.mocked(startRecording).mockRejectedValue(new Error('NotAllowedError'))
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone not available. Check the browser permission.')
  })

  it('shows an alert when the upload fails', async () => {
    recordingThatStops(new Blob(['opus'], { type: 'audio/webm' }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 413, json: async () => ({}) })))
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stop recording/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your message could not be sent.')
  })

  it('a cancelled recording uploads nothing', async () => {
    recordingThatStops(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    openWidget()
    fireEvent.click(screen.getByRole('button', { name: /record a voice message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /stop recording/i }))
    expect(await screen.findByRole('button', { name: /record a voice message/i })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('merges the history with live messages by id and skips empty text bubbles', () => {
    openWidget()
    act(() => FakeSocket.last.emit({ type: 'message', message: { id: 2, sender: 'agent', type: 'text', text: 'Live reply' } }))
    act(() => FakeSocket.last.emit({ type: 'history', messages: [
      { id: 1, sender: 'contact', type: 'text', text: 'Earlier' },
      { id: 3, sender: 'system', type: 'text', text: null },
    ] }))
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Earlier', 'Live reply'])
  })

  it('mergeMessages replaces by id and keeps id order', () => {
    const a = { id: 1, sender: 'contact' as const, type: 'text' as const, text: 'a' }
    const b = { id: 2, sender: 'agent' as const, type: 'text' as const, text: 'b' }
    expect(mergeMessages([b], [a, { ...b, text: 'b2' }])).toEqual([a, { ...b, text: 'b2' }])
  })

  it('the close button does not submit anything', () => {
    openWidget()
    expect(screen.getByRole('button', { name: /close chat/i })).toHaveAttribute('type', 'button')
  })
})
