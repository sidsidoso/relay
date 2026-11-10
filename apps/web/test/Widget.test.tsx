import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Widget, visitorToken } from '../src/components/Widget'

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
})
