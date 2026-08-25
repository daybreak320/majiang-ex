import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { runAIGame } from './ai'
import { createInitialGame } from './core'
import { executeCommand } from './engine'
import { assertGameInvariants, deserializeGameState, replayEvents, serializeGameState, validateGameInvariants, validateGameState } from './replay'

function dingqueStates(seed: number): GameState[] {
  let state = createInitialGame(seed)
  const states: GameState[] = []
  for (const playerId of [0, 1, 2, 3] as const) {
    const result = executeCommand(state, { type: 'dingque', playerId, tileType: '万' })
    if (!result.ok)
      throw new Error(result.error)
    state = result.nextState
    states.push(state)
  }
  return states
}

describe('事件回放与状态不变量', () => {
  it('拒绝乱序、重复 sequence 和非稳定前缀，并保持输入不可变', () => {
    const game = runAIGame(1)
    const initial = createInitialGame(1)
    const events = structuredClone(game.events)
    const snapshot = structuredClone(events)
    expect(() => replayEvents(initial, [events[1], events[0]])).toThrow('必须连续')
    expect(() => replayEvents(initial, [events[0], events[0]])).toThrow('必须连续')
    const unstableIndex = events.findIndex(event => event.state === undefined)
    expect(unstableIndex).toBeGreaterThanOrEqual(0)
    expect(() => replayEvents(initial, events.slice(0, unstableIndex + 1))).toThrow('稳定事件')
    expect(events).toEqual(snapshot)
    expect(initial).toEqual(createInitialGame(1))
  })

  it('拒绝重复牌、缺牌、分数不守恒和非法完成状态', () => {
    const state = dingqueStates(960)[3]
    const duplicate = structuredClone(state)
    duplicate.players[0].hand[0] = duplicate.players[1].hand[0]
    expect(validateGameInvariants(duplicate).violations.some(violation => violation.code === 'duplicate_tile_id')).toBe(true)

    const missing = structuredClone(state)
    missing.wall.pop()
    expect(() => assertGameInvariants(missing)).toThrow('牌张总数')

    const badScore = structuredClone(state)
    badScore.players[0].score = 1
    expect(() => assertGameInvariants(badScore)).toThrow('分数总和')

    const badFinished = structuredClone(state)
    badFinished.phase = 'finished'
    expect(() => assertGameInvariants(badFinished)).toThrow('finished 状态')

    const badEvent = structuredClone(state)
    badEvent.events = [{ sequence: 1, type: 'game_finished', reason: 'wall_empty' }]
    badEvent.nextEventSequence = 2
    expect(() => assertGameInvariants(badEvent)).toThrow('未 finished 状态')

    const report = validateGameState(badScore)
    expect(report.valid).toBe(false)
    expect(report.errors.some(error => error.includes('分数'))).toBe(true)
    expect(validateGameState(createInitialGame(960)).valid).toBe(true)
  })

  it('按命令稳定检查点回放，并保持序列化一致', () => {
    for (const seed of [1, 17, 960]) {
      const states = dingqueStates(seed)
      const initial = createInitialGame(seed)
      for (const state of states) {
        assertGameInvariants(state)
        expect(replayEvents(initial, state.events)).toEqual(state)
      }

      const game = runAIGame(seed)
      assertGameInvariants(game)
      expect(replayEvents(initial, game.events)).toEqual(game)
      expect(deserializeGameState(serializeGameState(game))).toEqual(game)
    }
  })

  it('拒绝损坏的事件状态检查点', () => {
    const state = dingqueStates(960)[0]
    const events = structuredClone(state.events)
    const checkpoint = events[events.length - 1].state!
    checkpoint.wall.pop()
    expect(() => replayEvents(createInitialGame(960), events)).toThrow('状态检查点无效')
  })
})
