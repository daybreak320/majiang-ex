import type { TileType } from '../types'
import type { GameState, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { createInitialGame, createTileSet, sortTiles } from './core'
import { buildStrategicReminder } from './strategy'

function take(pool: TileInstance[], specification: string): TileInstance[] {
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map((character) => {
      const index = pool.findIndex(tile => tile.type === type && tile.value === Number(character))
      if (index < 0)
        throw new Error(`夹具缺少 ${character}${type}`)
      return pool.splice(index, 1)[0]
    })
  })
}

function fixture(hand = '123万 4567条 123456筒'): { state: GameState, pool: TileInstance[] } {
  const pool = createTileSet()
  const state = createInitialGame(301)
  state.phase = 'discarding'
  state.currentPlayer = 1
  state.responseWindow = null
  for (const player of state.players) {
    player.hand = []
    player.discards = []
    player.melds = []
    player.dingque = '万'
    player.hasWon = false
  }
  state.players[0].hand = sortTiles(take(pool, hand))
  state.wall = pool
  return { state, pool }
}

describe('战略级提醒', () => {
  it('从定缺阶段开始给出中性提醒，不提前假定对手选择', () => {
    const state = createInitialGame(302)
    const reminder = buildStrategicReminder(state)
    expect(reminder.posture).toBe('steady')
    expect(reminder.summary).toContain('先定缺')
    expect(reminder.recommendedAction).toBeNull()
  })

  it('三家同缺且用户坐庄时提示快跑；只有两家同缺不误触发', () => {
    const { state } = fixture()
    state.dealer = 0
    state.players[0].dingque = '条'
    state.players[1].dingque = '条'
    state.players[2].dingque = '条'
    state.players[3].dingque = '筒'
    expect(buildStrategicReminder(state)).toMatchObject({ posture: 'retreat', title: expect.stringContaining('同缺拥挤') })

    state.players[2].dingque = '万'
    expect(buildStrategicReminder(state).title).not.toContain('同缺拥挤')
  })

  it('牌型集中且两家缺目标门时提示清一色窗口', () => {
    const { state } = fixture('123456789万 23条 11筒')
    state.players[0].dingque = '筒'
    state.players[1].dingque = '万'
    state.players[2].dingque = '条'
    state.players[3].dingque = '万'
    const reminder = buildStrategicReminder(state)
    expect(reminder).toMatchObject({ posture: 'press', title: expect.stringContaining('清一色窗口') })
    expect(reminder.summary).toContain('2 家缺万')
  })

  it('对家打缺后连续推三张第二门时退出清一色竞争，两张不算强信号', () => {
    const { state, pool } = fixture('123456789万 23条 11筒')
    state.players[0].dingque = '筒'
    state.players[1].dingque = '万'
    state.players[2].dingque = '条'
    state.players[3].dingque = '万'
    state.players[2].discards = take(pool, '123条 258筒')
    const pressured = buildStrategicReminder(state)
    expect(pressured).toMatchObject({ posture: 'retreat', title: expect.stringContaining('对家抢门') })
    expect(pressured.summary).toContain('连续推 3 张筒')

    state.players[2].discards = state.players[2].discards.slice(0, -1)
    expect(buildStrategicReminder(state).title).not.toContain('对家抢门')
  })

  it('普通点炮且自摸活张充足时提示可过；末张与短牌墙不建议过胡', () => {
    const { state, pool } = fixture('123456789万 55万 34条')
    state.phase = 'responding'
    state.players[0].dingque = '筒'
    state.players[1].dingque = '万'
    state.players[2].dingque = '条'
    state.players[3].dingque = '万'
    const winningTile = take(pool, '2条')[0]
    state.players[3].discards.push(winningTile)
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 3,
      tile: winningTile,
      eligiblePlayers: [0],
      choices: {},
      resumePlayer: 0,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    state.wall = pool

    const reminder = buildStrategicReminder(state)
    expect(reminder).toMatchObject({ posture: 'press', recommendedAction: 'pass', title: expect.stringContaining('素胡可缓') })
    expect(reminder.summary).toContain('自摸活张')

    state.responseWindow.isLastTile = true
    expect(buildStrategicReminder(state).recommendedAction).toBeNull()
    state.responseWindow.isLastTile = false
    state.wall = state.wall.slice(0, 8)
    expect(buildStrategicReminder(state).recommendedAction).toBeNull()
  })

  it('对手暗牌变化不会改变提醒，战略推断只使用公开信息', () => {
    const { state } = fixture('123456789万 23条 11筒')
    state.players[0].dingque = '筒'
    state.players[1].dingque = '万'
    state.players[2].dingque = '条'
    state.players[3].dingque = '万'
    const before = buildStrategicReminder(state)
    state.players[2].hand = state.wall.slice(0, 13)
    expect(buildStrategicReminder(state)).toEqual(before)
  })
})
