const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/v1'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface User {
  id: string
  userKey: string
  displayName: string
  role: 'admin' | 'member'
}

export interface Container {
  id: string
  type: 'workspace' | 'space' | 'folder' | 'list'
  name: string
  parentId: string | null
  position: number
  visibility: 'public' | 'private'
  archivedAt: string | null
}

export interface FieldOption {
  id: string
  label: string
  color?: string
}

export interface FieldDefinition {
  id: string
  key: string
  name: string
  type: 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'checkbox'
  required: boolean
  options: FieldOption[]
  position: number
}

export interface StatusDefinition {
  id: string
  key: string
  name: string
  category: 'not_started' | 'active' | 'done' | 'closed'
  color: string
  position: number
}

export interface TaskAssignee {
  user: Pick<User, 'id' | 'userKey' | 'displayName'>
}

export interface Task {
  id: string
  title: string
  description: string | null
  statusId: string
  status: StatusDefinition
  primaryListId: string
  priority: 'urgent' | 'high' | 'normal' | 'low' | 'none'
  dueDate: string | null
  customValues: Record<string, unknown>
  assignees: TaskAssignee[]
  position: number
}

interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown }
}

async function request<T>(userKey: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-user-id': userKey,
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Flowboard API. Check that Docker Compose is running.')
  }

  const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
  if (!response.ok) {
    const payload = body as ErrorPayload | undefined
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `Request failed (${response.status}).`,
      payload?.error?.details,
    )
  }
  return body as T
}

export async function getCurrentUser(userKey: string) {
  return request<User>(userKey, '/me')
}

export async function getTree(userKey: string) {
  const result = await request<{ data: Container[] }>(userKey, '/containers/tree')
  return result.data
}

export async function getListConfiguration(userKey: string, listId: string) {
  const [statusResult, fieldResult] = await Promise.all([
    request<{ data: StatusDefinition[] }>(userKey, `/lists/${encodeURIComponent(listId)}/resolved-statuses`),
    request<{ data: FieldDefinition[] }>(userKey, `/lists/${encodeURIComponent(listId)}/resolved-fields`),
  ])
  return { statuses: statusResult.data, fields: fieldResult.data }
}

export async function getTasks(userKey: string, listId: string) {
  const result = await request<{ data: Task[]; pageInfo: { hasMore: boolean; nextCursor: string | null } }>(userKey, `/lists/${encodeURIComponent(listId)}/tasks?limit=100`)
  return result.data
}

export async function updateTask(userKey: string, taskId: string, changes: {
  title?: string
  description?: string
  statusId?: string
  priority?: Task['priority']
  dueDate?: string | null
  position?: number
  customFields?: Record<string, unknown>
}) {
  const result = await request<{ data: Task }>(userKey, `/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  })
  return result.data
}

export async function createTask(userKey: string, listId: string, task: {
  title: string
  statusId: string
  customFields: Record<string, unknown>
}) {
  const result = await request<{ data: Task }>(userKey, `/lists/${encodeURIComponent(listId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(task),
  })
  return result.data
}

export async function archiveTask(userKey: string, taskId: string) {
  return request<{ data: { id: string; archived: true } }>(userKey, `/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST' })
}
