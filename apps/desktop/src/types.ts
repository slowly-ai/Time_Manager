export type TaskStatus = 'todo' | 'running' | 'done'
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
  status: TaskStatus
  plannedMs: number
  dueDate?: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  completedAt?: string
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
  focusMinutes: number
  shortBreakMinutes: number
  longBreakMinutes: number
  longBreakEvery: number
  autoStartBreak: boolean
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
  theme: 'light', defaultMode: 'stopwatch', focusMinutes: 25, shortBreakMinutes: 5,
  longBreakMinutes: 15, longBreakEvery: 4, autoStartBreak: false, dailyGoalMs: 8 * 60 * 60 * 1000, switchBehavior: 'pause',
}

export const defaultState: ChronoState = { projects: [], tasks: [], sessions: [], settings: defaultSettings }

export function loadState(): ChronoState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!parsed) return defaultState
    return { ...defaultState, ...parsed, settings: { ...defaultSettings, ...parsed.settings } }
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
