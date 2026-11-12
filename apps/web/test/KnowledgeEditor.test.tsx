import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return { ...actual, api: { knowledgeList: vi.fn(), knowledgeFile: vi.fn(), saveKnowledge: vi.fn(), deleteKnowledge: vi.fn() } }
})

import { api, ApiError } from '../src/api'
import { KnowledgeEditor } from '../src/components/KnowledgeEditor'

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>
const file = (name: string) => ({ name, bytes: 10, updatedAt: '2026-11-12T10:00:00Z' })

beforeEach(() => {
  vi.clearAllMocks()
  mocked.knowledgeList.mockResolvedValue({ files: [file('acme-coworking.md')] })
  mocked.knowledgeFile.mockResolvedValue({ name: 'acme-coworking.md', content: '# Acme\n' })
  mocked.saveKnowledge.mockImplementation(async (name: string) => ({ file: file(name) }))
  mocked.deleteKnowledge.mockResolvedValue(undefined)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('KnowledgeEditor', () => {
  it('opens a file, edits and saves it', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'acme-coworking.md' }))
    const editor = await screen.findByLabelText(/content of acme-coworking.md/i)
    expect(editor).toHaveValue('# Acme\n')
    fireEvent.change(editor, { target: { value: '# Acme\n\n## Parking\nFree.\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save file/i }))
    await screen.findByText(/saved/i)
    expect(mocked.saveKnowledge).toHaveBeenCalledWith('acme-coworking.md', '# Acme\n\n## Parking\nFree.\n')
  })

  it('creates a new file, adding .md, and rejects bad names locally', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    const name = await screen.findByLabelText(/new file name/i)
    fireEvent.change(name, { target: { value: 'Bad Name' } })
    fireEvent.click(screen.getByRole('button', { name: /new file/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/lowercase letters, digits and dashes/i)
    fireEvent.change(name, { target: { value: 'parking' } })
    fireEvent.click(screen.getByRole('button', { name: /new file/i }))
    const editor = await screen.findByLabelText(/content of parking.md/i)
    fireEvent.change(editor, { target: { value: '# Parking\n' } })
    fireEvent.click(screen.getByRole('button', { name: /save file/i }))
    await waitFor(() => expect(mocked.saveKnowledge).toHaveBeenCalledWith('parking.md', '# Parking\n'))
    await waitFor(() => expect(mocked.knowledgeList).toHaveBeenCalledTimes(2))
  })

  it('deletes after confirming', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'acme-coworking.md' }))
    await screen.findByLabelText(/content of acme-coworking.md/i)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(mocked.deleteKnowledge).toHaveBeenCalledWith('acme-coworking.md'))
    expect(window.confirm).toHaveBeenCalled()
  })

  it('shows the API reason when a save is rejected', async () => {
    mocked.saveKnowledge.mockRejectedValue(new ApiError(413, 'too_large'))
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'acme-coworking.md' }))
    await screen.findByLabelText(/content of acme-coworking.md/i)
    fireEvent.click(screen.getByRole('button', { name: /save file/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i)
  })

  it('opens the existing file instead of a blank one when the new name is taken', async () => {
    render(<KnowledgeEditor onExpired={vi.fn()} />)
    await screen.findByRole('button', { name: 'acme-coworking.md' })
    fireEvent.change(screen.getByLabelText(/new file name/i), { target: { value: 'acme-coworking' } })
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    expect(await screen.findByLabelText(/content of acme-coworking.md/i)).toHaveValue('# Acme\n')
    expect(mocked.knowledgeFile).toHaveBeenCalledWith('acme-coworking.md')
  })
})
