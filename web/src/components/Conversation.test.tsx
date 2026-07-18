import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Conversation } from './Conversation'
import type { Message } from '../types'

const message = (id: string): Message => ({ id, thread_id:'t', role:'assistant', content:`Answer ${id}`, request_id:id, tier:'lite', tier_label:'Swico Lite', input_tokens:1, output_tokens:1, usage_source:'actual', charge_micros:1, status:'complete', created_at:new Date().toISOString() })

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

it('shows public tier and measured categories without monetary or routing details', () => {
  render(<Conversation messages={[message('cost-hidden')]} retry={vi.fn()} suggest={vi.fn()} />)
  fireEvent.click(screen.getByText('Details'))
  expect(screen.getByText('Swico Lite')).toBeInTheDocument()
  expect(screen.getByText(/Input 1 · Output 1 · Total 2 tokens/)).toBeInTheDocument()
  expect(screen.getByText('Measured usage')).toBeInTheDocument()
  expect(screen.queryByText(/₹/)).not.toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(/openai|gpt-|claude|anthropic|gemini|llama|mistral|deepseek|sarvam/i)
})

it('labels historical messages without a tier simply as Swico', () => {
  render(<Conversation messages={[{ ...message('historical'), tier:null, tier_label:'Swico' }]} retry={vi.fn()} suggest={vi.fn()} />)
  fireEvent.click(screen.getByText('Details'))
  expect(screen.getByText('Swico')).toBeInTheDocument()
})

it('renders user attachment cards and marks expired metadata without an open action', () => {
  const userMessage: Message = {
    ...message('attachment'), role:'user', content:'Attached: report.pdf', attachments:[{
      id:'upload-1', name:'report.pdf', media_type:'application/pdf', size_bytes:2048,
      created_at:new Date(Date.now() - 700_000).toISOString(), expires_at:new Date(Date.now() - 100_000).toISOString(),
      status:'expired', warnings:[],
    }],
  }
  render(<Conversation messages={[userMessage]} retry={vi.fn()} suggest={vi.fn()} />)
  expect(screen.getByText('report.pdf')).toBeInTheDocument()
  expect(screen.getByText('Expired')).toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:/open|download/i })).not.toBeInTheDocument()
})
