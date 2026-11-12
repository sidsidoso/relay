import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { Timeline } from '../src/components/Timeline'
import type { Message } from '../src/api'

const voice: Message = {
  id: 1, conversationId: 5, sender: 'contact', userId: null, type: 'audio', text: null,
  mediaPath: 'a.webm', mediaMime: 'audio/webm', transcription: null, createdAt: '2026-11-11T12:00:00Z',
}

describe('Timeline', () => {
  it('plays customer audio from the API and shows the transcription below it', () => {
    const { container } = render(<Timeline messages={[{ ...voice, transcription: { status: 'ok', text: 'Quanto custa uma sala?' } }]} />)
    expect(container.querySelector('audio')).toHaveAttribute('src', '/api/conversations/5/messages/1/audio')
    expect(screen.getByText('Quanto custa uma sala?')).toBeInTheDocument()
  })

  it.each([
    [null, 'Not transcribed yet'],
    [{ status: 'empty' as const }, 'No speech detected'],
    [{ status: 'failed' as const, error: 'http_422' }, 'Transcription failed (http_422)'],
  ])('shows the transcription state %j', (transcription, label) => {
    render(<Timeline messages={[{ ...voice, transcription }]} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('renders text messages without a player', () => {
    const { container } = render(<Timeline messages={[{ ...voice, type: 'text', text: 'hello', mediaPath: null, mediaMime: null }]} />)
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(container.querySelector('audio')).toBeNull()
  })
})

it('scrolls to the newest message when one arrives', () => {
  const msg = (id: number) => ({ id, conversationId: 1, sender: 'contact' as const, userId: null, type: 'text' as const, text: `m${id}`, mediaPath: null, mediaMime: null, transcription: null, createdAt: '2026-11-12T10:00:00Z' })
  const { container, rerender } = render(<Timeline messages={[msg(1)]} />)
  const list = container.querySelector('ol')!
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 500 })
  rerender(<Timeline messages={[msg(1), msg(2)]} />)
  expect(list.scrollTop).toBe(500)
})
