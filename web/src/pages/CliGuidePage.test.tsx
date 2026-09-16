import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, it } from 'vitest'
import { CliGuidePage } from './CliGuidePage'

it('renders the public install, activation, update, and shell guidance without provider leakage', () => {
  render(<MemoryRouter><CliGuidePage /></MemoryRouter>)
  expect(screen.getByRole('heading', { name:'Swico CLI' })).toBeInTheDocument()
  expect(screen.getByText('npm install -g @swiveltechnologies/swico')).toBeInTheDocument()
  expect(screen.getByText('swico login --tier lite')).toBeInTheDocument()
  expect(document.body.textContent).toContain('npm install -g @swiveltechnologies/swico@latest')
  expect(document.body.textContent).not.toMatch(/openai|anthropic|claude|gemini|llama|mistral|deepseek|gpt-/i)
})

it('keeps the public guide guest-aware and preserves the return route', () => {
  render(<MemoryRouter><CliGuidePage isAuthenticated={false} /></MemoryRouter>)
  const navigation = within(screen.getByRole('navigation', { name:'Guide navigation' }))
  expect(navigation.getByRole('link', { name:'Back to Swico' })).toHaveAttribute('href', '/')
  expect(navigation.getByRole('link', { name:'Sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fswico-cli')
})

it('uses an account-neutral authenticated header and exposes every guide section', () => {
  render(<MemoryRouter><CliGuidePage isAuthenticated /></MemoryRouter>)
  const navigation = within(screen.getByRole('navigation', { name:'Guide navigation' }))
  expect(navigation.getByRole('link', { name:'Open Swico' })).toHaveAttribute('href', '/')
  expect(navigation.queryByRole('link', { name:'Sign in' })).not.toBeInTheDocument()
  for (const label of ['Get started', 'Install', 'Sign in', 'Start Swico', 'Commands', 'Update', 'Reinstall', 'Uninstall', 'Shell completion', 'Troubleshooting', 'Security', 'Current limitation']) {
    expect(screen.getByRole('link', { name:label })).toBeInTheDocument()
  }
})

it('copies a command with accessible confirmation', async () => {
  const user = userEvent.setup()
  render(<MemoryRouter><CliGuidePage /></MemoryRouter>)
  const copy = screen.getAllByRole('button', { name:'Copy command' })[0]
  await user.click(copy)
  await waitFor(() => expect(screen.getAllByRole('button', { name:'Copied' })[0]).toBeInTheDocument())
})
