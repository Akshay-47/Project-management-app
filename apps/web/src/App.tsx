import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  archiveTask,
  createTask,
  getCurrentUser,
  getListConfiguration,
  getTasks,
  getTree,
  updateTask,
  type Container,
  type FieldDefinition,
  type StatusDefinition,
  type Task,
  type User,
} from './api/flowboard'
import './App.css'

type ViewMode = 'board' | 'list'
type Priority = 'urgent' | 'high' | 'normal' | 'low' | 'none'

const USERS = [
  { key: 'alice', name: 'Alice Chen', initials: 'AC' },
  { key: 'bob', name: 'Bob Rivera', initials: 'BR' },
  { key: 'carol', name: 'Carol Okafor', initials: 'CO' },
] as const

const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low', 'none']

function childrenOf(containers: Container[], parentId: string | null) {
  return containers.filter((container) => container.parentId === parentId)
}

function displayDate(value: string | null) {
  if (!value) return 'No due date'
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value))
}

function initials(name: string) {
  return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
}

function App() {
  const [userKey, setUserKey] = useState<string>('alice')
  const [user, setUser] = useState<User | null>(null)
  const [containers, setContainers] = useState<Container[]>([])
  const [selectedListId, setSelectedListId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<StatusDefinition[]>([])
  const [fields, setFields] = useState<FieldDefinition[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>('board')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [createValues, setCreateValues] = useState<Record<string, unknown>>({})

  const selectedList = containers.find((item) => item.id === selectedListId) ?? null
  const visibleLists = containers.filter((item) => item.type === 'list')
  const fieldsForTable = fields.slice(0, 2)
  const overdueCount = useMemo(() => tasks.filter((task) => task.dueDate && new Date(task.dueDate) < new Date()).length, [tasks])

  useEffect(() => {
    let cancelled = false
    Promise.all([getCurrentUser(userKey), getTree(userKey)])
      .then(([currentUser, tree]) => {
        if (cancelled) return
        setUser(currentUser)
        setContainers(tree)
        const firstList = tree.find((container) => container.type === 'list')
        setSelectedListId((current) => current && tree.some((item) => item.id === current) ? current : firstList?.id ?? null)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not connect to Flowboard.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userKey])

  useEffect(() => {
    if (!selectedListId) return
    let cancelled = false
    Promise.all([getListConfiguration(userKey, selectedListId), getTasks(userKey, selectedListId)])
      .then(([configuration, result]) => {
        if (cancelled) return
        setStatuses(configuration.statuses)
        setFields(configuration.fields)
        setTasks(result)
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load this list.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedListId, userKey])

  async function reloadTasks() {
    if (!selectedListId) return
    const [configuration, result] = await Promise.all([getListConfiguration(userKey, selectedListId), getTasks(userKey, selectedListId)])
    setStatuses(configuration.statuses)
    setFields(configuration.fields)
    setTasks(result)
  }

  async function changeTask(task: Task, changes: Parameters<typeof updateTask>[2]) {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateTask(userKey, task.id, changes)
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item))
      setSelectedTask(updated)
    } catch (cause: unknown) {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the task.')
    } finally {
      setSaving(false)
    }
  }

  async function saveTaskDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTask) return
    const form = new FormData(event.currentTarget)
    const customFields = Object.fromEntries(fields.map((field) => {
      const value = form.get(`field:${field.key}`)
      if (field.type === 'checkbox') return [field.key, value === 'on']
      if (field.type === 'number') return [field.key, value === '' ? null : Number(value)]
      if (field.type === 'multi_select') return [field.key, form.getAll(`field:${field.key}`)]
      return [field.key, value === '' ? null : value]
    }))
    await changeTask(selectedTask, {
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      statusId: String(form.get('statusId') ?? selectedTask.statusId),
      priority: String(form.get('priority') ?? 'none') as Priority,
      dueDate: form.get('dueDate') ? new Date(`${String(form.get('dueDate'))}T00:00:00.000Z`).toISOString() : null,
      customFields,
    })
  }

  async function handleCreateTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedListId || !statuses.length) return
    setSaving(true)
    setError(null)
    try {
      await createTask(userKey, selectedListId, { title: newTaskTitle, statusId: statuses[0]!.id, customFields: createValues })
      setShowCreateTask(false)
      setNewTaskTitle('')
      setCreateValues({})
      await reloadTasks()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not create task.')
    } finally {
      setSaving(false)
    }
  }

  async function handleArchiveTask(task: Task) {
    if (!window.confirm(`Archive “${task.title}”?`)) return
    setSaving(true)
    try {
      await archiveTask(userKey, task.id)
      setSelectedTask(null)
      await reloadTasks()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not archive task.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDrop(taskId: string, statusId: string) {
    const task = tasks.find((item) => item.id === taskId)
    if (task && task.statusId !== statusId) await changeTask(task, { statusId })
  }

  return (
    <div className="flowboard-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="Flowboard home"><span className="brand-mark">F</span><span>flowboard</span></a>
        <div className="workspace-switcher"><span className="workspace-icon">F</span><span><strong>Flowboard Team</strong><small>Workspace</small></span><span className="chevron">⌄</span></div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="workspace-tree" aria-label="Workspace lists">
          {containers.filter((item) => item.type === 'space').map((space) => (
            <section className="tree-space" key={space.id}>
              <div className="tree-heading"><span className="tree-caret">⌄</span><span className="space-dot" />{space.name}<button type="button" className="icon-button tree-add" aria-label={`Add to ${space.name}`}>＋</button></div>
              {childrenOf(containers, space.id).map((folder) => (
                <div className="tree-folder" key={folder.id}>
                  <div className="tree-heading folder-heading"><span className="tree-caret">⌄</span><span className="folder-icon">▰</span>{folder.name}</div>
                  {childrenOf(containers, folder.id).map((list) => (
                    <button type="button" key={list.id} className={`tree-list ${selectedListId === list.id ? 'selected' : ''}`} onClick={() => { setLoading(true); setError(null); setTasks([]); setSelectedListId(list.id) }}><span className="list-icon">☷</span><span>{list.name}</span><span className="tree-count">{selectedListId === list.id ? tasks.length : ''}</span></button>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-bottom"><button className="sidebar-link" type="button"><span>⚙</span> Settings</button><div className="profile-card"><div className="avatar avatar-plum">{user ? initials(user.displayName) : 'FB'}</div><span className="profile-info"><strong>{user?.displayName ?? 'Loading user'}</strong><small>{user?.role === 'admin' ? 'Workspace admin' : 'Team member'}</small></span><button type="button" className="icon-button" aria-label="Profile menu">···</button></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="crumb-separator">/</span><span>{selectedList ? containers.find((item) => item.id === selectedList.parentId)?.name : 'Loading'}</span><span className="crumb-separator">/</span><strong>{selectedList?.name ?? 'Choose a list'}</strong></div>
          <div className="topbar-actions"><button className="search-button" type="button"><span>⌕</span> Search <kbd>⌘ K</kbd></button><button className="icon-button notification-button" type="button" aria-label="Notifications">♧<i /></button><label className="user-switcher-label" htmlFor="user-switcher">Demo user</label><select id="user-switcher" className="user-switcher" value={userKey} onChange={(event) => { setLoading(true); setError(null); setTasks([]); setStatuses([]); setFields([]); setSelectedListId(null); setUserKey(event.target.value) }}>{USERS.map((demoUser) => <option value={demoUser.key} key={demoUser.key}>{demoUser.name}</option>)}</select></div>
        </header>

        <div className="content-wrap">
          {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
          <section className="list-heading"><div className="title-row"><div><div className="eyebrow">{selectedList ? containers.find((item) => item.id === selectedList.parentId)?.name : 'Your workspace'}</div><h1>{selectedList?.name ?? (loading ? 'Loading your workspace…' : 'No lists available')}</h1></div><button className="primary-button" type="button" onClick={() => setShowCreateTask(true)} disabled={!selectedListId || !statuses.length}>＋ <span>New task</span></button></div>
            <p className="list-description">A clear view of the work in progress, ready for your next big idea.</p><div className="list-meta"><span className="member-stack"><i className="avatar avatar-blue">AC</i><i className="avatar avatar-rose">BR</i><i className="avatar avatar-gold">CO</i></span><span>3 members</span><span className="meta-divider" /><span className="meta-dot" /> {visibleLists.length} lists in workspace</div>
          </section>
          <section className="stats-grid" aria-label="List summary"><article className="stat-card"><span className="stat-icon icon-violet">☷</span><div><small>Total tasks</small><strong>{tasks.length}</strong></div><span className="stat-foot">in this list</span></article><article className="stat-card"><span className="stat-icon icon-blue">◷</span><div><small>In progress</small><strong>{tasks.filter((task) => statuses.find((item) => item.id === task.statusId)?.category === 'active').length}</strong></div><span className="stat-foot">across columns</span></article><article className="stat-card"><span className="stat-icon icon-green">✓</span><div><small>Completed</small><strong>{tasks.filter((task) => statuses.find((item) => item.id === task.statusId)?.category === 'done').length}</strong></div><span className="stat-foot">tasks wrapped up</span></article><article className="stat-card"><span className="stat-icon icon-orange">⚑</span><div><small>Past due</small><strong>{overdueCount}</strong></div><span className="stat-foot">needs attention</span></article></section>
          <section className="work-section"><div className="work-toolbar"><div className="view-tabs" role="tablist" aria-label="Task views"><button type="button" role="tab" aria-selected={viewMode === 'board'} className={viewMode === 'board' ? 'active' : ''} onClick={() => setViewMode('board')}><span>▦</span> Board</button><button type="button" role="tab" aria-selected={viewMode === 'list'} className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}><span>☷</span> List</button></div><div className="toolbar-controls"><button type="button" className="secondary-button"><span>☷</span> Filter</button><button type="button" className="secondary-button"><span>↕</span> Sort</button><button type="button" className="icon-button more-button" aria-label="More view options">···</button></div></div>
            {loading ? <div className="loading-state"><span className="spinner" /> Loading tasks…</div> : !selectedListId ? <div className="empty-state">This user does not have access to any lists.</div> : viewMode === 'board' ? <div className="board" aria-label="Kanban board">{statuses.map((status) => { const columnTasks = tasks.filter((task) => task.statusId === status.id); return <section className="board-column" key={status.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (id) void handleDrop(id, status.id) }}><header className="column-header"><div className="column-title"><span className="status-dot" style={{ backgroundColor: status.color }} /><h2>{status.name}</h2><span className="column-count">{columnTasks.length}</span></div><button className="icon-button" type="button" aria-label={`More options for ${status.name}`}>···</button></header><div className="column-cards">{columnTasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => setSelectedTask(task)} />)}</div><button className="add-card" type="button" onClick={() => { setCreateValues({}); setShowCreateTask(true) }}>＋ Add task</button></section> })}</div> : <div className="task-table-wrap"><table className="task-table"><thead><tr><th>Task name</th><th>Status</th><th>Assignee</th><th>Priority</th><th>Due date</th>{fieldsForTable.map((field) => <th key={field.key}>{field.name}</th>)}</tr></thead><tbody>{tasks.map((task) => <tr key={task.id} onClick={() => setSelectedTask(task)}><td><span className="task-check">○</span><strong>{task.title}</strong></td><td><span className="table-status"><i className="status-dot" style={{ backgroundColor: task.status.color }} />{task.status.name}</span></td><td><AssigneeList task={task} /></td><td><PriorityBadge priority={task.priority} /></td><td>{displayDate(task.dueDate)}</td>{fieldsForTable.map((field) => <td key={field.key}>{formatFieldValue(task.customValues, field)}</td>)}</tr>)}</tbody></table></div>}
          </section>
        </div>
      </main>
      {selectedTask && <TaskDrawer task={selectedTask} statuses={statuses} fields={fields} saving={saving} onClose={() => setSelectedTask(null)} onSave={saveTaskDetails} onArchive={() => void handleArchiveTask(selectedTask)} />}
      {showCreateTask && selectedList && <CreateTaskDialog title={newTaskTitle} setTitle={setNewTaskTitle} fields={fields} values={createValues} setValues={setCreateValues} saving={saving} onClose={() => setShowCreateTask(false)} onSubmit={handleCreateTask} />}
    </div>
  )
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return <article className="task-card" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', task.id)} onClick={onOpen} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen() }} tabIndex={0} aria-label={`Open task ${task.title}`}><div className="task-card-top"><span className="task-id">FB-{task.id.slice(-4).toUpperCase()}</span><button className="icon-button card-menu" type="button" aria-label={`Task options for ${task.title}`} onClick={(event) => { event.stopPropagation(); onOpen() }}>···</button></div><h3>{task.title}</h3>{task.description && <p className="task-description">{task.description}</p>}<div className="task-card-tags"><PriorityBadge priority={task.priority} />{Boolean(task.customValues.component) && <span className="field-chip">{String(task.customValues.component)}</span>}</div><div className="task-card-footer"><AssigneeList task={task} /><span className={`due-date ${task.dueDate && new Date(task.dueDate) < new Date() ? 'overdue' : ''}`}>◷ {displayDate(task.dueDate)}</span></div></article>
}

function PriorityBadge({ priority }: { priority: string }) {
  const icons: Record<string, string> = { urgent: '↑↑', high: '↑', normal: '↗', low: '↓', none: '—' }
  return <span className={`priority priority-${priority}`}><span>{icons[priority] ?? '—'}</span>{priority === 'none' ? 'No priority' : priority}</span>
}

function AssigneeList({ task }: { task: Task }) {
  if (!task.assignees.length) return <span className="unassigned">Unassigned</span>
  return <span className="assignee-list">{task.assignees.map((assignee, index) => <span className={`avatar ${['avatar-blue', 'avatar-rose', 'avatar-gold'][index % 3]}`} key={assignee.user.id} title={assignee.user.displayName}>{initials(assignee.user.displayName)}</span>)}</span>
}

function formatFieldValue(values: Record<string, unknown>, field: FieldDefinition): string {
  const value = values[field.key]
  if (value === undefined || value === null || value === '') return '—'
  if (field.type === 'checkbox') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  if (field.type === 'single_select') return field.options.find((option) => option.id === value)?.label ?? String(value)
  return String(value)
}

function FieldInput({ field, value, onChange }: { field: FieldDefinition; value: unknown; onChange?: (value: unknown) => void }) {
  const common = { name: `field:${field.key}`, id: `field-${field.key}` }
  if (field.type === 'checkbox') return <label className="checkbox-row"><input {...common} type="checkbox" defaultChecked={Boolean(value)} onChange={(event) => onChange?.(event.target.checked)} /> {field.name}</label>
  if (field.type === 'single_select') return <select {...common} defaultValue={String(value ?? '')} onChange={(event) => onChange?.(event.target.value)}><option value="">Choose…</option>{field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
  if (field.type === 'multi_select') return <select {...common} multiple defaultValue={Array.isArray(value) ? value.map(String) : []} onChange={(event) => onChange?.(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
  const inputValue = field.type === 'date' && typeof value === 'string' ? value.slice(0, 10) : String(value ?? '')
  return <input {...common} type={type} defaultValue={inputValue} required={field.required} onChange={(event) => onChange?.(type === 'number' ? Number(event.target.value) : event.target.value)} />
}

function TaskDrawer({ task, statuses, fields, saving, onClose, onSave, onArchive }: { task: Task; statuses: StatusDefinition[]; fields: FieldDefinition[]; saving: boolean; onClose: () => void; onSave: (event: React.FormEvent<HTMLFormElement>) => void; onArchive: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="task-drawer" role="dialog" aria-modal="true" aria-label="Task details"><header className="drawer-header"><span className="task-id">FB-{task.id.slice(-4).toUpperCase()}</span><div><button className="secondary-button" type="button" onClick={onArchive} disabled={saving}>Archive</button><button className="icon-button" type="button" aria-label="Close task details" onClick={onClose}>×</button></div></header><form onSubmit={onSave}><div className="drawer-content"><label className="field-label" htmlFor="task-title">Task name</label><input id="task-title" name="title" className="task-title-input" defaultValue={task.title} required maxLength={500} /><label className="field-label" htmlFor="task-description">Description</label><textarea id="task-description" name="description" rows={4} defaultValue={task.description ?? ''} placeholder="Add a description…" /><div className="detail-grid"><label><span className="field-label">Status</span><select name="statusId" defaultValue={task.statusId}>{statuses.map((status) => <option value={status.id} key={status.id}>{status.name}</option>)}</select></label><label><span className="field-label">Priority</span><select name="priority" defaultValue={task.priority}>{PRIORITIES.map((priority) => <option value={priority} key={priority}>{priority}</option>)}</select></label><label><span className="field-label">Assignee</span><AssigneeList task={task} /></label><label><span className="field-label">Due date</span><input name="dueDate" type="date" defaultValue={task.dueDate?.slice(0, 10) ?? ''} /></label></div><h3 className="custom-fields-title">Custom fields</h3>{fields.map((field) => <label className="form-field" key={field.key} htmlFor={`field-${field.key}`}><span className="field-label">{field.name}{field.required && <i>Required</i>}</span><FieldInput field={field} value={task.customValues[field.key]} /></label>)}</div><footer className="drawer-footer"><span>{saving ? 'Saving…' : 'Changes are saved to your workspace'}</span><button className="primary-button" type="submit" disabled={saving}>Save changes</button></footer></form></section></div>
}

function CreateTaskDialog({ title, setTitle, fields, values, setValues, saving, onClose, onSubmit }: { title: string; setTitle: (value: string) => void; fields: FieldDefinition[]; values: Record<string, unknown>; setValues: (value: Record<string, unknown>) => void; saving: boolean; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-task-title"><header className="drawer-header"><h2 id="create-task-title">Create a task</h2><button className="icon-button" type="button" aria-label="Close create task" onClick={onClose}>×</button></header><form onSubmit={onSubmit}><div className="drawer-content"><label className="form-field"><span className="field-label">Task name</span><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={500} placeholder="What needs to get done?" /></label>{fields.filter((field) => field.required).map((field) => <label className="form-field" key={field.key} htmlFor={`field-${field.key}`}><span className="field-label">{field.name}<i>Required</i></span><FieldInput field={field} value={values[field.key]} onChange={(value) => setValues({ ...values, [field.key]: value })} /></label>)}</div><footer className="drawer-footer"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={saving || !title.trim()}>{saving ? 'Creating…' : 'Create task'}</button></footer></form></section></div>
}

export default App
