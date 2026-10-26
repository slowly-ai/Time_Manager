import { invoke } from '@tauri-apps/api/core'

export type TaskStatus = 'todo' | 'running' | 'done'
export type TaskRecurrence = 'none' | 'daily'
export type Priority = 'low' | 'medium' | 'high'
export type TimerMode = 'stopwatch' | 'pomodoro'
export type PomodoroPhase = 'focus' | 'short_break' | 'long_break'
export type SessionStatus = 'running' | 'paused' | 'completed' | 'cancelled'

export interface Project {
  id: string
  name: string
  color: string
  archived: boolean
  createdAt: string
}

export interface Task {
  id: string
  title: string
  description: string
  projectId: string
  priority: Priority
  recurrence: TaskRecurrence
  status: TaskStatus
  plannedMs: number
  dueDate?: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  todayAddedOn?: string
  todayDismissedOn?: string
}

export interface FocusSession {
  id: string
  taskId: string
  projectId: string
  mode: TimerMode
  phase: PomodoroPhase
  pomodoroIndex: number
  startedAt: string
  endedAt?: string
  pausedAt?: string
  accumulatedMs: number
  status: SessionStatus
}

export interface TaskCompletion {
  id: string
  taskId: string
  day: string
  status: 'completed' | 'incomplete' | 'deferred'
  completedAt?: string
  updatedAt: string
}

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  defaultMode: TimerMode
  stopwatchFocusMinutes: number
  stopwatchBreakMinutes: number
  focusMinutes: number
  shortBreakMinutes: number
  longBreakMinutes: number
  longBreakEvery: number
  phaseEndReminderEnabled: boolean
  dailyGoalMs: number
  switchBehavior: 'pause' | 'complete'
}

export interface ChronoState {
  projects: Project[]
  tasks: Task[]
  sessions: FocusSession[]
  taskCompletions: TaskCompletion[]
  settings: Settings
}

const STORAGE_KEY = 'chronodesk-store-v2'
const BACKUP_STORAGE_KEY = `${STORAGE_KEY}-backup`
let saveQueue = Promise.resolve()

export const defaultSettings: Settings = {
  theme: 'light', defaultMode: 'stopwatch', stopwatchFocusMinutes: 45, stopwatchBreakMinutes: 10,
  focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 10, longBreakEvery: 2,
  phaseEndReminderEnabled: true, dailyGoalMs: 8 * 60 * 60 * 1000, switchBehavior: 'pause',
}

export const defaultState: ChronoState = { projects: [], tasks: [], sessions: [], taskCompletions: [], settings: defaultSettings }

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function hydrateState(value: unknown): ChronoState {
  if (!value || typeof value !== 'object') throw new Error('无效的数据结构')
  const parsed = value as Partial<ChronoState>
  if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.sessions) || !parsed.settings || typeof parsed.settings !== 'object') {
    throw new Error('数据结构不完整')
  }
  const hydrated: ChronoState = {
    ...defaultState,
    ...parsed,
    tasks: parsed.tasks.map((task: Partial<Task>) => ({ recurrence: 'none' as TaskRecurrence, ...task })) as Task[],
    sessions: parsed.sessions,
    taskCompletions: Array.isArray(parsed.taskCompletions)
      ? parsed.taskCompletions.filter((completion: Partial<TaskCompletion>) => Boolean(completion.id && completion.taskId && completion.day)).map((completion: Partial<TaskCompletion>) => ({
        ...completion,
        status: completion.status ?? 'completed',
        updatedAt: completion.updatedAt ?? completion.completedAt ?? new Date().toISOString(),
      } as TaskCompletion))
      : [],
    projects: parsed.projects,
    settings: {
      ...defaultSettings,
      ...parsed.settings,
      stopwatchFocusMinutes: parsed.settings?.stopwatchFocusMinutes ?? 45,
      stopwatchBreakMinutes: parsed.settings?.stopwatchBreakMinutes ?? 10,
      longBreakEvery: parsed.settings?.longBreakEvery ?? 2,
      phaseEndReminderEnabled: parsed.settings?.phaseEndReminderEnabled ?? true,
    },
  }
  return rolloverRecurringTasks(mergeDuplicateTasks(hydrated))
}

function readBrowserState(): string | null {
  return localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(BACKUP_STORAGE_KEY)
}

export async function loadState(): Promise<ChronoState> {
  if (isTauriRuntime()) {
    const persisted = await invoke<string | null>('load_state')
    if (persisted) return hydrateState(JSON.parse(persisted))

    // Migrate existing installs from localStorage once, then use the file-backed store.
    const legacy = readBrowserState()
    if (!legacy) return defaultState
    const migrated = hydrateState(JSON.parse(legacy))
    await invoke('save_state', { state: JSON.stringify(migrated) })
    return migrated
  }

  const persisted = readBrowserState()
  return persisted ? hydrateState(JSON.parse(persisted)) : defaultState
}

export async function saveState(state: ChronoState) {
  const serialized = JSON.stringify(state)
  if (isTauriRuntime()) {
    const write = saveQueue.catch(() => undefined).then(() => invoke('save_state', { state: serialized }))
    saveQueue = write.then(() => undefined, () => undefined)
    await write
    return
  }
  const write = saveQueue.catch(() => undefined).then(() => {
    const previous = localStorage.getItem(STORAGE_KEY)
    if (previous) localStorage.setItem(BACKUP_STORAGE_KEY, previous)
    localStorage.setItem(STORAGE_KEY, serialized)
  })
  saveQueue = write.then(() => undefined, () => undefined)
  await write
}

export function createId(prefix: string) { return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}` }

export function sessionElapsed(session: FocusSession, now = Date.now()) {
  if (session.status !== 'running') return Math.max(0, session.accumulatedMs)
  return Math.max(0, session.accumulatedMs + now - new Date(session.startedAt).getTime())
}

/** Ignore duplicate or stale timer actions; completed history is never a timer target. */
export function transitionActiveSession(state: ChronoState, previous: FocusSession, replacements: FocusSession[]): ChronoState {
  const current = state.sessions.find((session) => session.id === previous.id)
  if (!current || (current.status !== 'running' && current.status !== 'paused')
    || current.status !== previous.status || current.startedAt !== previous.startedAt
    || current.accumulatedMs !== previous.accumulatedMs || current.phase !== previous.phase) return state
  return { ...state, sessions: [...state.sessions.filter((session) => session.id !== previous.id), ...replacements] }
}

export function formatDuration(ms: number, includeHours = true) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (includeHours || hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

export function isFocusSession(session: FocusSession) { return session.phase === 'focus' }

export const MIN_RECORDABLE_SESSION_MS = 60 * 1000

export function todayKey(now = Date.now()) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function tomorrowKey(now = Date.now()) {
  const date = new Date(now)
  date.setDate(date.getDate() + 1)
  return todayKey(date.getTime())
}

export function isTaskVisibleToday(task: Pick<Task, 'recurrence' | 'todayAddedOn' | 'todayDismissedOn'>, day = todayKey()) {
  if (task.todayDismissedOn === day) return false
  if (task.recurrence === 'daily') return task.todayAddedOn === day
  return !task.todayAddedOn || task.todayAddedOn === day
}

export function isTaskCompletedOnDay(taskId: string, completions: TaskCompletion[], day = todayKey()) {
  return completions.some((completion) => completion.taskId === taskId && completion.day === day && completion.status === 'completed')
}

export function taskCompletionForDay(taskId: string, completions: TaskCompletion[], day = todayKey()) {
  return completions.find((completion) => completion.taskId === taskId && completion.day === day)
}

export function setTaskCompletion(completions: TaskCompletion[], taskId: string, status: TaskCompletion['status'], day = todayKey(), completedAt?: string) {
  const now = new Date().toISOString()
  const next = { id: createId('completion'), taskId, day, status, completedAt: status === 'completed' ? completedAt : undefined, updatedAt: now } satisfies TaskCompletion
  const index = completions.findIndex((completion) => completion.taskId === taskId && completion.day === day)
  if (index < 0) return [...completions, next]
  return completions.map((completion, itemIndex) => itemIndex === index ? { ...completion, ...next, id: completion.id } : completion)
}

export function removeTaskCompletion(completions: TaskCompletion[], taskId: string, day = todayKey()) {
  return completions.filter((completion) => !(completion.taskId === taskId && completion.day === day))
}

export function addTaskToToday(task: Task, day = todayKey()): Task {
  return { ...task, todayAddedOn: day, todayDismissedOn: undefined, status: 'todo', completedAt: undefined }
}

export function dismissTaskForToday(task: Task, day = todayKey()): Task {
  return { ...task, todayDismissedOn: day, status: 'todo', completedAt: undefined }
}

export function deferTaskForTomorrow(task: Task, day = todayKey()): Task {
  return { ...task, todayAddedOn: tomorrowKey(new Date(`${day}T00:00:00`).getTime()), todayDismissedOn: undefined, status: 'todo', completedAt: undefined }
}

export function isRecordableSession(session: FocusSession, now = Date.now()) {
  return sessionElapsed(session, now) >= MIN_RECORDABLE_SESSION_MS
}

export function normalizeTaskKey(task: Pick<Task, 'projectId' | 'title'>) {
  return `${task.projectId.trim()}::${task.title.trim().toLocaleLowerCase()}`
}

function taskTimestamp(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** Merge duplicate task shells while keeping every historical session. */
export function mergeDuplicateTasks(state: ChronoState): ChronoState {
  const groups = new Map<string, Task[]>()
  for (const task of state.tasks) {
    const key = normalizeTaskKey(task)
    const group = groups.get(key) ?? []
    group.push(task)
    groups.set(key, group)
  }
  if (![...groups.values()].some((group) => group.length > 1)) return state

  const taskIdMap = new Map<string, string>()
  const merged: Task[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => taskTimestamp(a.createdAt) - taskTimestamp(b.createdAt) || a.sortOrder - b.sortOrder)
    const primary = group[0]
    const latest = [...group].sort((a, b) => taskTimestamp(b.updatedAt) - taskTimestamp(a.updatedAt))[0]
    const mergedTask: Task = {
      ...primary,
      title: latest.title.trim() || primary.title,
      description: latest.description || primary.description,
      priority: latest.priority,
      plannedMs: latest.plannedMs,
      recurrence: group.some((task) => task.recurrence === 'daily') ? 'daily' : latest.recurrence,
      status: group.some((task) => task.status === 'running') ? 'running' : latest.status,
      completedAt: latest.completedAt,
      updatedAt: latest.updatedAt,
    }
    merged.push(mergedTask)
    group.forEach((task) => taskIdMap.set(task.id, primary.id))
  }
  return {
    ...state,
    tasks: merged.sort((a, b) => a.sortOrder - b.sortOrder),
    sessions: state.sessions.map((session) => {
      const taskId = taskIdMap.get(session.taskId) ?? session.taskId
      return taskId === session.taskId ? session : { ...session, taskId }
    }),
    taskCompletions: state.taskCompletions.map((completion) => ({ ...completion, taskId: taskIdMap.get(completion.taskId) ?? completion.taskId })),
  }
}

export function rolloverRecurringTasks(state: ChronoState, now = Date.now()): ChronoState {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const todayStart = today.getTime()
  let changed = false
  const tasks = state.tasks.map((task) => {
    if (task.recurrence !== 'daily') return task
    const day = todayKey(now)
    if (task.todayDismissedOn === day || (task.todayAddedOn && task.todayAddedOn >= day)) return task
    changed = true
    return { ...task, todayAddedOn: day, todayDismissedOn: undefined, status: 'todo' as const, completedAt: undefined, updatedAt: new Date(now).toISOString() }
  })
  return changed ? { ...state, tasks } : state
}
