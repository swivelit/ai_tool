import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, vi } from 'vitest'
import {
  approveKnowledgeDocument,
  cancelKnowledgeJob,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
} from '../api/client'
import type { KnowledgeDocument, ReadyAttachment } from '../types'
import { KnowledgeLibrary } from './KnowledgeLibrary'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    approveKnowledgeDocument: vi.fn(),
    cancelKnowledgeJob: vi.fn(),
    deleteKnowledgeDocument: vi.fn(),
    listKnowledgeDocuments: vi.fn(),
    reindexKnowledgeDocument: vi.fn(),
  }
})

const user = {} as never
const upload: ReadyAttachment = {
  id: 'upload-1',
  name: 'project-notes.pdf',
  media_type: 'application/pdf',
  size_bytes: 100,
  created_at: '2026-07-31T00:00:00Z',
  expires_at: '2026-07-31T01:00:00Z',
  warnings: [],
  status: 'ready',
}
const readyDocument: KnowledgeDocument = {
  id: 'document-1',
  title: 'project-notes.pdf',
  status: 'ready',
  source_kind: 'approved_document',
  chunk_count: 3,
  approved_at: '2026-07-31T00:00:00Z',
  created_at: '2026-07-31T00:00:00Z',
  updated_at: '2026-07-31T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listKnowledgeDocuments).mockResolvedValue([])
  vi.mocked(deleteKnowledgeDocument).mockResolvedValue()
  vi.mocked(cancelKnowledgeJob).mockResolvedValue({
    status: 'cancelled',
    updated_at: '2026-07-31T00:00:00Z',
  })
})

it('requires explicit approval before saving a temporary upload', async () => {
  vi.mocked(approveKnowledgeDocument).mockResolvedValue({
    document: { ...readyDocument, status: 'indexing' },
    job: { status: 'queued', updated_at: '2026-07-31T00:00:00Z' },
  })
  render(<KnowledgeLibrary user={user} uploads={[upload]} />)

  const save = screen.getByRole('button', { name: 'Save document' })
  expect(save).toBeDisabled()
  await userEvent.selectOptions(
    screen.getByLabelText('Uploaded document'),
    upload.id,
  )
  expect(save).toBeDisabled()
  await userEvent.click(
    screen.getByLabelText('Save to my Knowledge Library'),
  )
  expect(save).toBeEnabled()
  await userEvent.click(save)

  await waitFor(() => expect(approveKnowledgeDocument).toHaveBeenCalledWith(
    user,
    upload.id,
  ))
  expect(await screen.findByText('Indexing · 3 sections')).toBeInTheDocument()
  expect(screen.getByText(/remain in your Knowledge Library until you remove them/i)).toBeInTheDocument()
})

it('lists, re-indexes, and removes owner documents without internal job details', async () => {
  vi.mocked(listKnowledgeDocuments).mockResolvedValue([readyDocument])
  vi.mocked(reindexKnowledgeDocument).mockResolvedValue({
    document: readyDocument,
    job: { status: 'queued', updated_at: '2026-07-31T00:00:00Z' },
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<KnowledgeLibrary user={user} uploads={[]} />)

  expect(await screen.findByText('project-notes.pdf')).toBeInTheDocument()
  expect(screen.getByText('Ready · 3 sections')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Re-index' }))
  await waitFor(() => expect(reindexKnowledgeDocument).toHaveBeenCalledWith(
    user,
    readyDocument.id,
  ))
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(deleteKnowledgeDocument).toHaveBeenCalledWith(
    user,
    readyDocument.id,
  ))
  expect(screen.queryByText('project-notes.pdf')).not.toBeInTheDocument()
  expect(screen.queryByText(/job-|provider|model|embedding/i)).not.toBeInTheDocument()
  confirm.mockRestore()
})

it('keeps raw document data out of the UI when a request fails', async () => {
  vi.mocked(listKnowledgeDocuments).mockRejectedValue(
    new Error('private-source-text SECRET_TOKEN'),
  )
  render(<KnowledgeLibrary user={user} uploads={[]} />)
  expect(await screen.findByText(
    'The Knowledge Library request could not be completed. Try again.',
  )).toBeInTheDocument()
  expect(screen.queryByText(/private-source-text|SECRET_TOKEN/)).not.toBeInTheDocument()
})

it('cancels pending indexing without exposing an internal job identifier', async () => {
  vi.mocked(listKnowledgeDocuments).mockResolvedValue([
    { ...readyDocument, status: 'indexing' },
  ])
  render(<KnowledgeLibrary user={user} uploads={[]} />)

  await userEvent.click(
    await screen.findByRole('button', { name: 'Cancel indexing' }),
  )
  await waitFor(() => expect(cancelKnowledgeJob).toHaveBeenCalledWith(
    user,
    readyDocument.id,
  ))
  expect(await screen.findByText('Failed · 3 sections')).toBeInTheDocument()
  expect(screen.getByText('Indexing cancelled.')).toBeInTheDocument()
  expect(screen.queryByText(/job-/i)).not.toBeInTheDocument()
})
