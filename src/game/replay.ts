import type { GameEvent, GameState } from './types'
import { assertGameInvariants, validateGameInvariants } from './invariants'

export { assertGameInvariants, validateGameInvariants }

export interface GameStateValidation {
  valid: boolean
  errors: string[]
}

export function validateGameState(state: GameState): GameStateValidation {
  const report = validateGameInvariants(state)
  return {
    valid: report.valid,
    errors: report.violations.map(violation => violation.message),
  }
}

export function replayEvents(initialState: GameState, events: readonly GameEvent[]): GameState {
  const initial = structuredClone(initialState)
  const replayedEvents = structuredClone(events)
  let state = initial

  for (const event of replayedEvents) {
    const expected = state.events.length + 1
    if (event.sequence !== expected)
      throw new Error(`事件 sequence 必须连续：期望 ${expected}，实际为 ${event.sequence}`)
    const history = [...state.events, event]
    if (event.state !== undefined) {
      state = {
        ...structuredClone(event.state),
        events: history,
        nextEventSequence: event.sequence + 1,
      }
      try {
        assertGameInvariants(state)
      }
      catch (error) {
        throw new Error(`事件 ${event.sequence} 的状态检查点无效：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    else {
      state.events = history
      state.nextEventSequence = event.sequence + 1
    }
  }

  if (replayedEvents.length > 0 && replayedEvents[replayedEvents.length - 1].state === undefined)
    throw new Error('回放必须结束于带状态检查点的稳定事件')
  assertGameInvariants(state)
  return state
}

export function serializeGameState(state: GameState): string {
  assertGameInvariants(state)
  return JSON.stringify(state)
}

export function deserializeGameState(serialized: string): GameState {
  const state = JSON.parse(serialized) as GameState
  assertGameInvariants(state)
  return state
}
