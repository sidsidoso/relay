import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return { ...actual, api: { list: vi.fn(), get: vi.fn(), reply: vi.fn(), assign: vi.fn(), handBack: vi.fn(), close: vi.fn(), logout: vi.fn() } }
})
vi.mock('../src/live', () => ({ connectLive: vi.fn(() => ({ stop: vi.fn(), send: vi.fn() })) }))

import { api, ApiError } from '../src/api'
import { connectLive } from '../src/live'
import { Inbox } from '../src/pages/Inbox'

const user = { id: 1, email: 'a@b.c', name: 'Agent' }
const conv = (id: number) => ({
  id, contactId: id, channel: 'widget', status: 'open' as const, assigneeId: null, agentTurns: 0,
  tags: [], handoffReason: null, createdAt: 'x', updatedAt: 'x',
})
const summary = (id: number, name: string) => ({ ...conv(id), contactName: name, lastMessage: null, assigneeName: null })
const detail = (id: number, name: string) => ({
  conversation: conv(id), contact: { id, channel: 'widget', contactKey: 'k', name },
  messages: [{ id: id * 100, conversationId: id, sender: 'contact' as const, userId: null, type: 'text' as const, text: `hi from ${name}`, mediaPath: null, mediaMime: null, transcription: null, createdAt: 'x' }],
})

const mocked = api as unknown as Record<keyof typeof api, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()
  mocked.list.mockResolvedValue({ conversations: [summary(1, 'Ana'), summary(2, 'Bob')] })
  mocked.get.mockImplementation(async (id: number) => detail(id, id === 1 ? 'Ana' : 'Bob'))
})

async function openFirst(onLogout = vi.fn()) {
  render(<Inbox user={user} onLogout={onLogout} />)
  fireEvent.click(await screen.findByRole('button', { name: /Ana/ }))
  await screen.findByPlaceholderText(/reply as the team/i)
  return onLogout
}

describe('Inbox', () => {
  it('keeps the draft and shows an alert when the reply fails', async () => {
    mocked.reply.mockRejectedValue(new ApiError(500, 'error'))
    await openFirst()
    const input = screen.getByPlaceholderText(/reply as the team/i)
    fireEvent.change(input, { target: { value: 'my answer' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send. Try again.')
    expect(input).toHaveValue('my answer')
  })

  it('clears the draft and shows the message when the reply succeeds', async () => {
    mocked.reply.mockResolvedValue({ message: { ...detail(1, 'Ana').messages[0]!, id: 999, sender: 'user', text: 'my answer' } })
    await openFirst()
    const input = screen.getByPlaceholderText(/reply as the team/i)
    fireEvent.change(input, { target: { value: 'my answer' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('my answer')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('returns to login when the list call answers 401', async () => {
    mocked.list.mockRejectedValue(new ApiError(401, 'unauthorized'))
    const onLogout = vi.fn()
    render(<Inbox user={user} onLogout={onLogout} />)
    await waitFor(() => expect(onLogout).toHaveBeenCalled())
  })

  it('returns to login when the inbox socket closes with 4401', async () => {
    const onLogout = vi.fn()
    render(<Inbox user={user} onLogout={onLogout} />)
    await screen.findByRole('button', { name: /Ana/ })
    const onClose = vi.mocked(connectLive).mock.calls[0]![3]!
    act(() => onClose(4401))
    expect(onLogout).toHaveBeenCalled()
  })

  it('shows an alert when an action fails', async () => {
    mocked.close.mockRejectedValue(new ApiError(500, 'error'))
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Action failed. Try again.')
  })

  it('does not render a stale conversation when the selection changes while loading', async () => {
    let resolveFirst!: (v: ReturnType<typeof detail>) => void
    mocked.get.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
    render(<Inbox user={user} onLogout={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bob/ }))
    expect(await screen.findByText('hi from Bob')).toBeInTheDocument()
    await act(async () => { resolveFirst(detail(1, 'Ana')) })
    expect(screen.queryByText('hi from Ana')).toBeNull()
    expect(screen.getByText('hi from Bob')).toBeInTheDocument()
  })
})
