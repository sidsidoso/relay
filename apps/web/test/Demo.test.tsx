import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('../src/components/Widget', () => ({ Widget: () => null }))
import { Demo } from '../src/pages/Demo'

it('shows the demo credentials', () => {
  render(<Demo />)
  expect(screen.getByText('demo@relay.dev')).toBeInTheDocument()
  expect(screen.getByText('relay-demo')).toBeInTheDocument()
})

it('says that demo conversations are visible to anyone', () => {
  render(<Demo />)
  expect(screen.getByText(/public demo/i)).toBeInTheDocument()
})
