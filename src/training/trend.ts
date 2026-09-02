import type { TrainingTrend, TrainingTrendDimension } from './types'
import { loadGameHistory } from '../game/persistence'
import { loadDecisionEvents } from './decisionEvents'
import { TRAINING_ALGORITHM_VERSION } from './types'

export function calculateTrainingTrend(): TrainingTrend {
  const events = loadDecisionEvents().filter(event => event.algorithmVersion === TRAINING_ALGORITHM_VERSION)
  const games = new Set(events.map(event => event.seed)).size
  const dimensions: TrainingTrendDimension[] = []
  const add = (key: TrainingTrendDimension['key'], label: string, values: number[], invert = false): void => {
    const enough = values.length >= 5
    const midpoint = Math.floor(values.length / 2)
    const first = values.slice(0, midpoint)
    const second = values.slice(midpoint)
    const avg = (list: number[]): number => list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length
    const delta = enough ? avg(second) - avg(first) : 0
    const normalized = invert ? -delta : delta
    dimensions.push({ key, label, direction: !enough || Math.abs(normalized) < 0.5 ? 'flat' : normalized > 0 ? 'up' : 'down', delta: normalized, sampleCount: values.length })
  }
  add('opportunity', '机会数', events.map(event => event.opportunityActual))
  add('safety', '防守安全', events.map(event => event.safety))
  add('loss', '机会损失', events.map(event => event.opportunityLoss), true)
  return { algorithmVersion: TRAINING_ALGORITHM_VERSION, games, decisions: events.length, ready: games >= 3 && dimensions.every(d => d.sampleCount >= 5), dimensions }
}

export function loadTrendHistory(): ReturnType<typeof loadGameHistory> {
  return loadGameHistory()
}
