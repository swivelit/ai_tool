import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Conversation } from './Conversation'
import type { Message } from '../types'

const message = (id: string): Message => ({ id, thread_id:'t', role:'assistant', content:`Answer ${id}`, request_id:id, provider:'openai', model:'gpt', input_tokens:1, output_tokens:1, usage_source:'actual', charge_micros:1, status:'complete', created_at:new Date().toISOString() })

it('auto-scrolls only while near the bottom and offers a return button', () => {
  const scrollTo = vi.fn(); const { rerender } = render(<Conversation messages={[message('1')]} retry={vi.fn()} suggest={vi.fn()} />)
  const conversation = screen.getByTestId('conversation')
  conversation.scrollTo = scrollTo
  Object.defineProperties(conversation, { scrollHeight:{ configurable:true, value:1000 }, clientHeight:{ configurable:true, value:200 }, scrollTop:{ configurable:true, writable:true, value:0 } })
  fireEvent.scroll(conversation); const calls = scrollTo.mock.calls.length
  rerender(<Conversation messages={[message('1'), message('2')]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(scrollTo).toHaveBeenCalledTimes(calls)
  fireEvent.click(screen.getByRole('button', { name:'Scroll to bottom' })); expect(scrollTo.mock.calls.length).toBe(calls + 1)
})

it('shows token provenance and categories without monetary message cost', () => {
  render(<Conversation messages={[message('cost-hidden')]} retry={vi.fn()} suggest={vi.fn()} />)
  fireEvent.click(screen.getByText('Details'))
  expect(screen.getByText(/Input 1 · Output 1 · Total 2 tokens/)).toBeInTheDocument()
  expect(screen.getByText('Provider-reported usage')).toBeInTheDocument()
  expect(screen.queryByText(/₹/)).not.toBeInTheDocument()
})
