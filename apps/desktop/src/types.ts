export type EventStatus = 'active' | 'archived'
export type SessionStatus = 'running' | 'paused' | 'completed' | 'cancelled'

export interface TempoEvent {
  id: string
  title: string
  description: string
  category: string
  color: string
  status: EventStatus
  createdAt: string
  updatedAt: string
  totalMs: number
  lastSessionAt?: string
}

export interface TempoSession {
  id: string
  eventId: string
  startedAt: string
  endedAt?: string
  pausedAt?: string
  elapsedMs: number
  status: SessionStatus
  note?: string
}

export interface StoreState {
  events: TempoEvent[]
  sessions: TempoSession[]
  allowParallel: boolean
  theme: 'light' | 'dark' | 'system'
  timezone: string
}

const STORAGE_KEY = 'tempo-store-v1'

const seedEvents: TempoEvent[] = [
  { id: 'deep-work', title: '深度工作', description: '需要完整注意力的创作与研究时间', category: '工作', color: '#86a9ff', status: 'active', createdAt: '2026-10-12T01:00:00.000Z', updatedAt: '2026-10-15T01:30:00.000Z', totalMs: 3_726_000, lastSessionAt: '2026-10-15T01:30:00.000Z' },
  { id: 'reading', title: '阅读与输入', description: '书籍、文章和课程的阅读时间', category: '成长', color: '#8fceb7', status: 'active', createdAt: '2026-10-11T08:00:00.000Z', updatedAt: '2026-10-14T12:20:00.000Z', totalMs: 2_916_000, lastSessionAt: '2026-10-14T12:20:00.000Z' },
  { id: 'exercise', title: '运动', description: '训练、散步和身体恢复', category: '生活', color: '#efb477', status: 'active', createdAt: '2026-10-09T11:00:00.000Z', updatedAt: '2026-10-13T10:10:00.000Z', totalMs: 1_830_000, lastSessionAt: '2026-10-13T10:10:00.000Z' },
  { id: 'planning', title: '每周规划', description: '整理任务、回顾和安排下一步', category: '工作', color: '#b59bdc', status: 'active', createdAt: '2026-10-10T04:00:00.000Z', updatedAt: '2026-10-12T03:00:00.000Z', totalMs: 1_254_000, lastSessionAt: '2026-10-12T03:00:00.000Z' },
]

const initialState: StoreState = { events: seedEvents, sessions: [], allowParallel: false, theme: 'light', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }

export function loadStore(): StoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState
    return { ...initialState, ...JSON.parse(raw) }
  } catch {
    return initialState
  }
}

export function saveStore(state: StoreState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}
