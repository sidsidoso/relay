import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return { ...actual, api: { list: vi.fn(), get: vi.fn(), reply: vi.fn(), assign: vi.fn(), handBack: vi.fn(), close: vi.fn(), logout: vi.fn(), agentRuns: vi.fn() } }
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
  mocked.list.mockResolvedValue({ conversations: [summary(1, 'Ana'), summary(2, 'Bob')], nextCursor: null })
  mocked.get.mockImplementation(async (id: number) => detail(id, id === 1 ? 'Ana' : 'Bob'))
  mocked.agentRuns.mockResolvedValue({ runs: [] })
})

const agentRun = (id: number, outcome: 'replied' | 'transferred' | 'failed') => ({
  id, conversationId: 1, provider: 'demo', model: 'scripted', durationMs: 5, inputTokens: null, outputTokens: null, outcome, error: null, createdAt: '2026-11-10T12:00:00Z',
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

  it('keeps the detail visible when the already selected conversation is clicked again', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: /Ana/ }))
    expect(await screen.findByRole('heading', { name: 'Ana' })).toBeInTheDocument()
    expect(screen.queryByText('Select a conversation')).toBeNull()
    expect(screen.getByText('hi from Ana')).toBeInTheDocument()
  })

  it('does not carry the draft of one conversation over to another', async () => {
    await openFirst()
    fireEvent.change(screen.getByPlaceholderText(/reply as the team/i), { target: { value: 'for Ana only' } })
    fireEvent.click(screen.getByRole('button', { name: /Bob/ }))
    expect(await screen.findByText('hi from Bob')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/reply as the team/i)).toHaveValue('')
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

  it('shows agent runs and adds live ones for the open conversation, without duplicates', async () => {
    mocked.agentRuns.mockResolvedValue({ runs: [agentRun(1, 'replied')] })
    await openFirst()
    expect(await screen.findByText('Replied')).toBeInTheDocument()
    const onFrame = vi.mocked(connectLive).mock.calls[0]![1] as (f: unknown) => void
    act(() => onFrame({ event: 'agent.run.created', data: { conversationId: 1, run: agentRun(2, 'transferred') } }))
    act(() => onFrame({ event: 'agent.run.created', data: { conversationId: 1, run: agentRun(2, 'transferred') } }))
    act(() => onFrame({ event: 'agent.run.created', data: { conversationId: 2, run: { ...agentRun(3, 'failed'), conversationId: 2 } } }))
    expect(await screen.findAllByText('Handed off')).toHaveLength(1)
    expect(screen.queryByText('Failed')).toBeNull()
  })

  it('still opens the conversation when loading agent runs fails', async () => {
    mocked.agentRuns.mockRejectedValue(new ApiError(500, 'error'))
    await openFirst()
    expect(await screen.findByText('No agent activity yet')).toBeInTheDocument()
    expect(screen.getByText('hi from Ana')).toBeInTheDocument()
  })

  it('debounces list refreshes triggered by frames', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openFirst()
      const before = mocked.list.mock.calls.length
      const onFrame = vi.mocked(connectLive).mock.calls[0]![1] as (f: unknown) => void
      act(() => { for (let i = 0; i < 5; i++) onFrame({ event: 'conversation.updated', data: { conversation: conv(2) } }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(350) })
      expect(mocked.list.mock.calls.length - before).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('replaces a message when its transcription arrives', async () => {
    const audio = { ...detail(1, 'Ana').messages[0]!, id: 101, type: 'audio' as const, text: null, mediaPath: 'a.webm', mediaMime: 'audio/webm' }
    mocked.get.mockImplementation(async (id: number) => ({ ...detail(id, id === 1 ? 'Ana' : 'Bob'), messages: [audio] }))
    await openFirst()
    expect(await screen.findByText('Not transcribed yet')).toBeInTheDocument()
    const onFrame = vi.mocked(connectLive).mock.calls[0]![1] as (f: unknown) => void
    act(() => onFrame({ event: 'message.updated', data: { conversationId: 1, message: { ...audio, transcription: { status: 'ok', text: 'Quanto custa?' } } } }))
    expect(await screen.findByText('Quanto custa?')).toBeInTheDocument()
    expect(screen.queryByText('Not transcribed yet')).toBeNull()
  })

  it('sends a reply once even when submitted twice quickly', async () => {
    let resolve!: (v: unknown) => void
    mocked.reply.mockReturnValue(new Promise((r) => { resolve = r }))
    await openFirst()
    const input = screen.getByPlaceholderText(/reply as the team/i)
    fireEvent.change(input, { target: { value: 'once' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.submit(input.closest('form')!)
    expect(mocked.reply).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ message: { ...detail(1, 'Ana').messages[0]!, id: 998, sender: 'user', text: 'once' } }) })
  })

  it('keeps a newer draft typed while the reply was in flight', async () => {
    let resolve!: (v: unknown) => void
    mocked.reply.mockReturnValue(new Promise((r) => { resolve = r }))
    await openFirst()
    const input = screen.getByPlaceholderText(/reply as the team/i)
    fireEvent.change(input, { target: { value: 'first' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.change(input, { target: { value: 'second thought' } })
    await act(async () => { resolve({ message: { ...detail(1, 'Ana').messages[0]!, id: 997, sender: 'user', text: 'first' } }) })
    expect(input).toHaveValue('second thought')
  })

  it('labels the reply box and marks the active filter', async () => {
    await openFirst()
    expect(screen.getByLabelText(/^reply$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('loads more conversations with the cursor', async () => {
    mocked.list.mockImplementation(async (_f: string, page?: { before?: string }) => page?.before
      ? { conversations: [summary(3, 'Cid')], nextCursor: null }
      : { conversations: [summary(1, 'Ana'), summary(2, 'Bob')], nextCursor: 'c1' })
    render(<Inbox user={user} onLogout={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    expect(await screen.findByRole('button', { name: /Cid/ })).toBeInTheDocument()
    expect(mocked.list).toHaveBeenLastCalledWith('all', { before: 'c1' })
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })
})
