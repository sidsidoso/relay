import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/api', async (orig) => {
  const actual = await orig<typeof import('../src/api')>()
  return { ...actual, api: { login: vi.fn() } }
})

import { api } from '../src/api'
import { Login } from '../src/pages/Login'

it('disables the button while signing in', async () => {
  let resolve!: (v: unknown) => void
  ;(api.login as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => { resolve = r }))
  render(<Login onLoggedIn={vi.fn()} />)
  const button = screen.getByRole('button', { name: /sign in/i })
  fireEvent.click(button)
  expect(button).toBeDisabled()
  await act(async () => { resolve({ user: { id: 1, email: 'demo@relay.dev', name: 'Demo' } }) })
})
