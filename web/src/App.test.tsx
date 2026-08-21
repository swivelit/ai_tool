import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { App } from './App'

vi.mock('./auth/useAuth', () => ({ useAuth: () => ({ user:null, loading:false }) }))
vi.mock('./pages/ChatPage', () => ({ ChatPage: () => <main>Chat</main> }))

const legalRoutes = [
  ['/legal/terms', 'Terms and Conditions'],
  ['/legal/privacy', 'Privacy Policy'],
  ['/legal/refunds', 'Cancellation and Refund Policy'],
  ['/legal/contact', 'Contact and Support'],
  ['/legal/ai', 'AI Use and Limitations Policy'],
  ['/legal/delivery', 'Digital Service Delivery / Shipping Policy'],
  ['/legal/pricing', 'Pricing and Token Credits'],
  ['/pricing', 'Pricing and Token Credits'],
] as const

it.each(legalRoutes)('renders the approved policy at %s', async (route, heading) => {
  render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  expect(await screen.findByRole('heading', { level:1, name:heading })).toBeInTheDocument()
  expect(screen.getByText('Version 1.0 · Effective date: 2026-07-17')).toBeInTheDocument()
  expect(screen.queryByText('Policy text is not published')).not.toBeInTheDocument()
})
