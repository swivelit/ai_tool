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
  ['/legal/ai', 'AI Limitations'],
  ['/legal/delivery', 'Digital Service Delivery / Shipping Policy'],
  ['/legal/pricing', 'Pricing and Top-up Information'],
  ['/pricing', 'Pricing and Top-up Information'],
] as const

it.each(legalRoutes)('keeps %s accessible and visibly unpublished', async (route, heading) => {
  render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  expect(await screen.findByRole('heading', { level:1, name:heading })).toBeInTheDocument()
  expect(screen.getByText('Policy text is not published')).toBeInTheDocument()
  expect(screen.getByText(/Razorpay Live Mode remains blocked/)).toBeInTheDocument()
})
