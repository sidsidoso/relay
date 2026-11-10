import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConversationList } from '../src/components/ConversationList'
import type { ConversationSummary } from '../src/api'

const base: ConversationSummary = {
  id: 1, contactId: 1, channel: 'widget', status: 'open', assigneeId: null, agentTurns: 0, tags: [],
  handoffReason: null, createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z',
  contactName: 'Ana', lastMessage: 'Hi!', assigneeName: null,
}

describe('ConversationList', () => {
  it('shows contact, last message and a waiting badge, and selects on click', () => {
    const onSelect = vi.fn()
    render(<ConversationList
      items={[base, { ...base, id: 2, contactName: null, status: 'waiting_human', lastMessage: '[audio]' }]}
      selectedId={1} onSelect={onSelect} />)
    expect(screen.getByText('Ana')).toBeInTheDocument()
    expect(screen.getByText('Visitor #2')).toBeInTheDocument()
    expect(screen.getByText('Waiting for human')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Visitor #2'))
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it('shows an empty state', () => {
    render(<ConversationList items={[]} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
  })
})
