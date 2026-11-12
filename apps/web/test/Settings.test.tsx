import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return {
    ...actual,
    api: {
      settings: vi.fn(), saveSettings: vi.fn(),
      knowledgeList: vi.fn(async () => ({ files: [] })), knowledgeFile: vi.fn(), saveKnowledge: vi.fn(), deleteKnowledge: vi.fn(),
    },
  }
})

import { api, ApiError } from '../src/api'
import { SettingsPage } from '../src/pages/Settings'

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>
const current = { instructions: 'Be nice.', handoffKeywords: ['human', 'humano'], turnLimit: 10, handoffMessage: 'Hold on.', transcriptionEnabled: true }

beforeEach(() => {
  vi.clearAllMocks()
  mocked.settings.mockResolvedValue({ settings: current })
  mocked.knowledgeList.mockResolvedValue({ files: [] })
})

describe('SettingsPage', () => {
  it('loads the settings and saves the edited values', async () => {
    mocked.saveSettings.mockImplementation(async (patch) => ({ settings: { ...current, ...patch } }))
    render(<SettingsPage onLogout={vi.fn()} />)
    const limit = await screen.findByLabelText(/turn limit/i)
    expect(screen.getByLabelText(/handoff keywords/i)).toHaveValue('human, humano')
    fireEvent.change(limit, { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(/handoff keywords/i), { target: { value: 'human, , manager ' } })
    fireEvent.click(screen.getByLabelText(/transcribe voice messages/i))
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await screen.findByText(/saved/i)
    expect(mocked.saveSettings).toHaveBeenCalledWith({
      instructions: 'Be nice.', handoffKeywords: ['human', 'manager'], turnLimit: 4, handoffMessage: 'Hold on.', transcriptionEnabled: false,
    })
  })

  it('marks the invalid fields when the API rejects the values', async () => {
    mocked.saveSettings.mockRejectedValue(new ApiError(400, 'invalid_request', ['turnLimit']))
    render(<SettingsPage onLogout={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/check the highlighted fields/i)
    expect(screen.getByLabelText(/turn limit/i)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText(/instructions/i)).toHaveAttribute('aria-invalid', 'false')
  })

  it('does not save twice while a save is in flight', async () => {
    let resolve!: (v: unknown) => void
    mocked.saveSettings.mockReturnValue(new Promise((r) => { resolve = r }))
    render(<SettingsPage onLogout={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /save settings/i })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocked.saveSettings).toHaveBeenCalledTimes(1)
    resolve({ settings: current })
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('goes back to login on 401', async () => {
    mocked.settings.mockRejectedValue(new ApiError(401, 'unauthorized'))
    const onLogout = vi.fn()
    render(<SettingsPage onLogout={onLogout} />)
    await waitFor(() => expect(onLogout).toHaveBeenCalled())
  })
})
