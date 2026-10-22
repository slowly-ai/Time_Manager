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
  settings: Settings
}

const STORAGE_KEY = 'chronodesk-store-v2'

export const defaultSettings: Settings = {
  theme: 'light', defaultMode: 'stopwatch', stopwatchFocusMinutes: 45, stopwatchBreakMinutes: 10,
  focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 10, longBreakEvery: 2,
  phaseEndReminderEnabled: true, dailyGoalMs: 8 * 60 * 60 * 1000, switchBehavior: 'pause',
}

export const defaultState: ChronoState = { projects: [], tasks: [], sessions: [], settings: defaultSettings }

export function loadState(): ChronoState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!parsed) return defaultState
    const hydrated: ChronoState = {
      ...defaultState,
      ...parsed,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((task: Partial<Task>) => ({ recurrence: 'none' as TaskRecurrence, ...task })) : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
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
  } catch { return defaultState }
}

export function saveState(state: ChronoState) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) }

export function createId(prefix: string) { return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}` }

export function sessionElapsed(session: FocusSession, now = Date.now()) {
  if (session.status !== 'running') return Math.max(0, session.accumulatedMs)
  return Math.max(0, session.accumulatedMs + now - new Date(session.startedAt).getTime())
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

export function isTaskVisibleToday(task: Pick<Task, 'recurrence' | 'todayAddedOn' | 'todayDismissedOn'>, day = todayKey()) {
  if (task.todayDismissedOn === day) return false
  if (task.recurrence === 'daily') return task.todayAddedOn === day
  return !task.todayAddedOn || task.todayAddedOn === day
}

export function addTaskToToday(task: Task, day = todayKey()): Task {
  return { ...task, todayAddedOn: day, todayDismissedOn: undefined, status: 'todo', completedAt: undefined }
}

export function dismissTaskForToday(task: Task, day = todayKey()): Task {
  return { ...task, todayDismissedOn: day, status: 'todo', completedAt: undefined }
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
  }
}

export function rolloverRecurringTasks(state: ChronoState, now = Date.now()): ChronoState {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const todayStart = today.getTime()
  let changed = false
  const tasks = state.tasks.map((task) => {
    if (task.recurrence !== 'daily' || task.status !== 'done' || !task.completedAt) return task
    if (taskTimestamp(task.completedAt) >= todayStart) return task
    changed = true
    return { ...task, status: 'todo' as const, completedAt: undefined, updatedAt: new Date(now).toISOString() }
  })
  return changed ? { ...state, tasks } : state
}
