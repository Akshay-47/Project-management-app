// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { getCurrentUser, getListConfiguration, getTasks, getTree, updateTask } from './api/flowboard'
import type { Container, FieldDefinition, StatusDefinition, Task, User } from './api/flowboard'

vi.mock('./api/flowboard', async () => {
  const actual = await vi.importActual<typeof import('./api/flowboard')>('./api/flowboard')
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getListConfiguration: vi.fn(),
    getTasks: vi.fn(),
    getTree: vi.fn(),
    updateTask: vi.fn(),
    createTask: vi.fn(),
    archiveTask: vi.fn(),
  }
})

const user: User = { id: 'user-alice', userKey: 'alice', displayName: 'Alice Chen', role: 'admin' }
const containers: Container[] = [
  { id: 'space-eng', type: 'space', name: 'Engineering', parentId: 'workspace', position: 0, visibility: 'public', archivedAt: null },
  { id: 'folder-q2', type: 'folder', name: 'Q2 Launch', parentId: 'space-eng', position: 0, visibility: 'public', archivedAt: null },
  { id: 'list-inbox', type: 'list', name: 'Inbox', parentId: 'folder-q2', position: 0, visibility: 'public', archivedAt: null },
  { id: 'list-backlog', type: 'list', name: 'Backlog', parentId: 'folder-q2', position: 1, visibility: 'public', archivedAt: null },
]
const privateList: Container = { id: 'list-roadmap', type: 'list', name: 'Roadmap', parentId: 'folder-q2', position: 2, visibility: 'private', archivedAt: null }
const statuses: StatusDefinition[] = [
  { id: 'status-todo', key: 'todo', name: 'To do', category: 'not_started', color: '#8492a6', position: 0 },
  { id: 'status-progress', key: 'in_progress', name: 'Doing', category: 'active', color: '#1e88a8', position: 1 },
  { id: 'status-done', key: 'done', name: 'Done', category: 'done', color: '#26a269', position: 2 },
]
const fields: FieldDefinition[] = [
  { id: 'field-estimate', key: 'estimate', name: 'Estimate', type: 'number', required: true, options: [], position: 0 },
  { id: 'field-component', key: 'component', name: 'Component', type: 'single_select', required: false, options: [{ id: 'api', label: 'API' }, { id: 'web', label: 'Web' }], position: 1 },
]
const task: Task = {
  id: 'task-1234', title: 'Review API contract', description: 'Check the endpoint contract.', statusId: 'status-progress',
  status: statuses[1]!, primaryListId: 'list-backlog', priority: 'high', dueDate: null,
  customValues: { estimate: 3, component: 'api' },
  assignees: [{ user: { id: 'user-bob', userKey: 'bob', displayName: 'Bob Rivera' } }], position: 0,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Flowboard list workflow', () => {
  it('selects a list, shows resolved board columns, edits a custom field, and saves', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(user)
    vi.mocked(getTree).mockResolvedValue(containers)
    vi.mocked(getListConfiguration).mockResolvedValue({ statuses, fields })
    vi.mocked(getTasks).mockResolvedValue([task])
    vi.mocked(updateTask).mockImplementation(async (_userKey, _taskId, changes) => ({
      ...task,
      ...changes,
      customValues: { ...task.customValues, ...changes.customFields },
    }))

    render(<App />)

    await screen.findByText('Review API contract')
    fireEvent.click(screen.getByRole('button', { name: /Backlog/ }))
    expect(await screen.findByRole('heading', { name: 'Doing' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'To do' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('article', { name: 'Open task Review API contract' }))
    const dialog = screen.getByRole('dialog', { name: /task details/i })
    const estimateInput = within(dialog).getByLabelText(/Estimate/)
    fireEvent.change(estimateInput, { target: { value: '8' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateTask).toHaveBeenCalledWith('alice', 'task-1234', expect.objectContaining({ customFields: expect.objectContaining({ estimate: 8 }) })))
  })

  it('removes private lists when switching from Alice to Bob', async () => {
    vi.mocked(getCurrentUser).mockImplementation(async (userKey) => ({
      ...user,
      userKey,
      displayName: userKey === 'alice' ? 'Alice Chen' : 'Bob Rivera',
      role: userKey === 'alice' ? 'admin' : 'member',
    }))
    vi.mocked(getTree).mockImplementation(async (userKey) => userKey === 'alice' ? [...containers, privateList] : containers)
    vi.mocked(getListConfiguration).mockResolvedValue({ statuses, fields })
    vi.mocked(getTasks).mockResolvedValue([])

    render(<App />)
    expect(await screen.findByRole('button', { name: /Roadmap/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Demo user'), { target: { value: 'bob' } })

    await waitFor(() => expect(screen.queryByRole('button', { name: /Roadmap/ })).not.toBeInTheDocument())
    expect(getTree).toHaveBeenLastCalledWith('bob')
  })
})
