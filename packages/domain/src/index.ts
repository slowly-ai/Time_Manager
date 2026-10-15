export type TimerStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled'

export interface TimerSession {
  id: string
  eventId: string
  status: TimerStatus
  startedAt: string
  endedAt?: string
  pausedAt?: string
  elapsedMs: number
  updatedAt: string
}

export function canTransition(from: TimerStatus, to: TimerStatus): boolean {
  const transitions: Record<TimerStatus, TimerStatus[]> = {
    idle: ['running', 'cancelled'],
    running: ['paused', 'completed', 'cancelled'],
    paused: ['running', 'completed', 'cancelled'],
    completed: [],
    cancelled: [],
  }
  return transitions[from].includes(to)
}

export function transitionTimer(session: TimerSession, next: TimerStatus, now = new Date()): TimerSession {
  if (!canTransition(session.status, next)) {
    throw new Error(`Invalid timer transition: ${session.status} -> ${next}`)
  }
  const iso = now.toISOString()
  const nextSession = { ...session, status: next, updatedAt: iso }
  if (next === 'paused') nextSession.pausedAt = iso
  if (next === 'completed' || next === 'cancelled') nextSession.endedAt = iso
  return nextSession
}

export function elapsedSince(startedAt: string, pausedAt?: string, now = new Date()): number {
  if (pausedAt) return Math.max(0, new Date(pausedAt).getTime() - new Date(startedAt).getTime())
  return Math.max(0, now.getTime() - new Date(startedAt).getTime())
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}
