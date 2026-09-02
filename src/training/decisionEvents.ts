import type { DiscardDecision } from '../review/types'
import type { DecisionEventRecord } from './types'
import { TRAINING_ALGORITHM_VERSION } from './types'

const KEY = 'majiang-ex:decision-events'
const LIMIT = 1000

function read(): DecisionEventRecord[] {
  if (typeof window === 'undefined')
    return []
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value as DecisionEventRecord[] : []
  }
  catch { return [] }
}

export function loadDecisionEvents(): DecisionEventRecord[] {
  return read()
}

export function recordDecisionEvents(seed: number, decisions: readonly DiscardDecision[]): void {
  if (typeof window === 'undefined')
    return
  const now = Date.now()
  const records = decisions.map((decision): DecisionEventRecord => ({
    seed,
    sequence: decision.sequence,
    opportunityActual: decision.opportunityActual,
    opportunityBest: decision.opportunityBest,
    opportunityLoss: decision.opportunityLoss,
    safety: decision.safety,
    isLateGame: decision.isLateGame,
    createdAt: now,
    algorithmVersion: TRAINING_ALGORITHM_VERSION,
  }))
  const existing = read().filter(item => item.seed !== seed)
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...records, ...existing].slice(0, LIMIT)))
  }
  catch {
    // Storage unavailable.
  }
}
