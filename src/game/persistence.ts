import type { GameState } from './types'
import { validateGameInvariants } from './invariants'

export const GAME_SAVE_KEY = 'majiang-ex:unfinished-game'
export const GAME_SAVE_SCHEMA_VERSION = 1

export interface GameSave {
  schemaVersion: number
  state: GameState
  stableEventSequence: number
  savedAt: number
}

export interface ReviewIssueSample {
  title: string
  actual: string
  recommended: string
  reason: string
}

export interface GameHistoryEntry {
  finishedAt: number
  seed: number
  endReason: string
  score: number
  rank: number
  hasWon: boolean
  winFan: number | null
  dealtIn: number
  decisionsExcellent: number
  decisionsReasonable: number
  decisionsImprovable: number
  issues: ReviewIssueSample[]
  reviewAlgorithmVersion?: string
}

export const GAME_HISTORY_KEY = 'majiang-ex:game-history'
export const GAME_HISTORY_LIMIT = 12

export const REVIEW_FEEDBACK_KEY = 'majiang-ex:review-feedback'
export const REVIEW_FEEDBACK_LIMIT = 200

export type ReviewFeedbackVerdict = 'accepted' | 'rejected'

export interface ReviewFeedback {
  seed: number
  sequence: number
  conclusionKind: string
  verdict: ReviewFeedbackVerdict
  reason: string
  algorithmVersion: string
  createdAt: number
}

function storage(): Storage | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined')
    return null
  return window.localStorage
}

export function recordFinishedGame(entry: GameHistoryEntry): void {
  const store = storage()
  if (store === null)
    return
  try {
    const history = loadGameHistory()
    history.unshift(entry)
    store.setItem(GAME_HISTORY_KEY, JSON.stringify(history.slice(0, GAME_HISTORY_LIMIT)))
  }
  catch {
    // Storage full or unavailable; analysis stays valid for this session only.
  }
}

export function loadGameHistory(): GameHistoryEntry[] {
  const store = storage()
  if (store === null)
    return []
  try {
    const raw = store.getItem(GAME_HISTORY_KEY)
    if (raw === null)
      return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value))
      return []
    return value.filter((item): item is GameHistoryEntry =>
      typeof item === 'object'
      && item !== null
      && typeof (item as GameHistoryEntry).finishedAt === 'number'
      && typeof (item as GameHistoryEntry).seed === 'number'
      && typeof (item as GameHistoryEntry).score === 'number'
      && Array.isArray((item as GameHistoryEntry).issues))
  }
  catch {
    return []
  }
}

function isReviewFeedback(value: unknown): value is ReviewFeedback {
  if (typeof value !== 'object' || value === null)
    return false
  const candidate = value as Partial<ReviewFeedback>
  return typeof candidate.seed === 'number'
    && typeof candidate.sequence === 'number'
    && typeof candidate.conclusionKind === 'string'
    && (candidate.verdict === 'accepted' || candidate.verdict === 'rejected')
    && typeof candidate.reason === 'string'
    && typeof candidate.algorithmVersion === 'string'
    && typeof candidate.createdAt === 'number'
}

export function loadReviewFeedback(): ReviewFeedback[] {
  const store = storage()
  if (store === null)
    return []
  try {
    const raw = store.getItem(REVIEW_FEEDBACK_KEY)
    if (raw === null)
      return []
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter(isReviewFeedback) : []
  }
  catch {
    return []
  }
}

export function recordReviewFeedback(entry: ReviewFeedback): void {
  const store = storage()
  if (store === null)
    return
  try {
    const retained = loadReviewFeedback().filter(item => !(
      item.seed === entry.seed
      && item.sequence === entry.sequence
      && item.conclusionKind === entry.conclusionKind
    ))
    store.setItem(REVIEW_FEEDBACK_KEY, JSON.stringify([entry, ...retained].slice(0, REVIEW_FEEDBACK_LIMIT)))
  }
  catch {
    // Feedback must never block the settlement page in restricted storage contexts.
  }
}

export function saveUnfinishedGame(state: GameState): void {
  if (state.phase === 'finished') {
    clearUnfinishedGame()
    return
  }
  const value: GameSave = {
    schemaVersion: GAME_SAVE_SCHEMA_VERSION,
    state,
    stableEventSequence: state.events.length === 0 ? 0 : state.events[state.events.length - 1].sequence,
    savedAt: Date.now(),
  }
  try {
    storage()?.setItem(GAME_SAVE_KEY, JSON.stringify(value))
  }
  catch {
    // Storage can be unavailable or full; the game remains playable in memory.
  }
}

export function loadUnfinishedGame(): GameSave | null {
  const store = storage()
  if (store === null)
    return null
  try {
    const raw = store.getItem(GAME_SAVE_KEY)
    if (raw === null)
      return null
    const value: unknown = JSON.parse(raw)
    if (!isGameSave(value)) {
      store.removeItem(GAME_SAVE_KEY)
      return null
    }
    const latestSequence = value.state.events.length === 0
      ? 0
      : value.state.events[value.state.events.length - 1].sequence
    if (value.state.phase === 'finished'
      || value.stableEventSequence !== latestSequence
      || !validateGameInvariants(value.state).valid) {
      store.removeItem(GAME_SAVE_KEY)
      return null
    }
    return value
  }
  catch {
    try {
      store.removeItem(GAME_SAVE_KEY)
    }
    catch {
      // Ignore storage failures in restricted browser contexts.
    }
    return null
  }
}

export function clearUnfinishedGame(): void {
  try {
    storage()?.removeItem(GAME_SAVE_KEY)
  }
  catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function isGameSave(value: unknown): value is GameSave {
  if (typeof value !== 'object' || value === null)
    return false
  const candidate = value as Partial<GameSave>
  const state = candidate.state as Partial<GameState> | undefined
  return candidate.schemaVersion === GAME_SAVE_SCHEMA_VERSION
    && typeof candidate.stableEventSequence === 'number'
    && typeof candidate.savedAt === 'number'
    && typeof state?.seed === 'number'
    && Array.isArray(state.events)
    && Array.isArray(state.players)
    && Array.isArray(state.wall)
    && typeof state.phase === 'string'
    && typeof state.nextEventSequence === 'number'
}
