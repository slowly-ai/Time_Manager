import { describe, expect, it } from 'vitest'
import { canTransition, formatDuration, transitionTimer } from './index.js'

describe('timer domain', () => {
  it('allows pause and resume but blocks completed transitions', () => {
    expect(canTransition('running', 'paused')).toBe(true)
    expect(canTransition('completed', 'running')).toBe(false)
  })

  it('records completion timestamp', () => {
    const result = transitionTimer({
      id: 'session', eventId: 'event', status: 'running', startedAt: '2026-10-15T00:00:00.000Z', elapsedMs: 0, updatedAt: '',
    }, 'completed', new Date('2026-10-15T01:00:00.000Z'))
    expect(result.endedAt).toBe('2026-10-15T01:00:00.000Z')
  })

  it('formats durations without shifting layout', () => {
    expect(formatDuration(3723000)).toBe('01:02:03')
    expect(formatDuration(90000)).toBe('01:30')
  })
})
