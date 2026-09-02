import { beforeEach, describe, expect, it } from 'vitest'
import { calculateTrainingTrend } from './trend'
import { TRAINING_ALGORITHM_VERSION } from './types'

function installEvents(count: number, games = 3): void {
  const events = Array.from({ length: count }, (_, index) => ({
    seed: index % games,
    sequence: index,
    opportunityActual: index < Math.floor(count / 2) ? 2 : 8,
    opportunityBest: 8,
    opportunityLoss: index < Math.floor(count / 2) ? 2 : 0,
    safety: index < Math.floor(count / 2) ? 0.3 : 0.8,
    isLateGame: false,
    createdAt: index,
    algorithmVersion: TRAINING_ALGORITHM_VERSION,
  }))
  window.localStorage.setItem('majiang-ex:decision-events', JSON.stringify(events))
}

describe('training trend thresholds', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear(), key: () => null, length: 0 } as Storage
    Object.defineProperty(globalThis, 'window', { value: { localStorage: store }, configurable: true })
  })

  it.each([5, 9, 10])('computes direction for %i samples while readiness stays per-dimension', (count) => {
    installEvents(count)
    const trend = calculateTrainingTrend()
    expect(trend.ready).toBe(count >= 5)
    expect(trend.dimensions[0].sampleCount).toBe(count)
    expect(trend.dimensions[0].direction).toBe(count >= 5 ? 'up' : 'flat')
  })
})
