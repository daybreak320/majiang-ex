import type { ReviewReport } from '../review/types'

export const TRAINING_ALGORITHM_VERSION = 'zhuyang-opportunity-v1'

export interface DecisionEventRecord {
  seed: number
  sequence: number
  opportunityActual: number
  opportunityBest: number
  opportunityLoss: number
  safety: number
  isLateGame: boolean
  createdAt: number
  algorithmVersion: string
}

export interface TrainingTrendDimension {
  key: 'opportunity' | 'safety' | 'loss'
  label: string
  direction: 'up' | 'down' | 'flat'
  delta: number
  sampleCount: number
}

export interface TrainingTrend {
  algorithmVersion: string
  games: number
  decisions: number
  ready: boolean
  dimensions: TrainingTrendDimension[]
}

export interface TrainingSummary {
  report: ReviewReport
  reviewedAt: number
}
