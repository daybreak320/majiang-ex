import type { TileType } from '../types'
import type { GameState, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { buildDiscardAssistant, countKnownCopies } from './assistant'
import { createInitialGame, createTileSet, sortTiles } from './core'

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

function fixture(): GameState {
  const pool = createTileSet()
  const state = createInitialGame(1)
  state.phase = 'discarding'
  state.currentPlayer = 0
  state.players[0].hand = sortTiles(take(pool, '123456789万 55万 34条 4条'))
  state.players[0].dingque = '筒'
  for (const player of state.players.slice(1)) {
    player.hand = []
    player.discards = []
    player.melds = []
    player.dingque = player.id === 1 ? '万' : '条'
  }
  state.wall = pool
  return state
}

describe('实时出牌助手', () => {
  it('推荐合法出牌并按全部未知牌计算下一张胡牌概率', () => {
    const state = fixture()
    const analysis = buildDiscardAssistant(state)
    expect(analysis.recommendation).toMatchObject({ type: 'discard', playerId: 0 })
    expect(analysis.recommendationLabel).toBe('打 4条')
    expect(analysis.opportunity).toBe(8)
    expect(analysis.waits.map(wait => `${wait.tile.value}${wait.tile.type}`)).toEqual(['2条', '5条'])
    expect(analysis.reason).toContain('机会质量良好')
    expect(analysis.knownTiles).toBe(14)
    expect(analysis.unknownTiles).toBe(94)
    expect(analysis.nextDrawWinProbability).toBeCloseTo(8 / 94)
  })

  it('对手暗牌不计入已知牌，公开牌计入并扣减叫口', () => {
    const state = fixture()
    state.players[1].hand = take(state.wall, '23456789筒 12345条')
    const hidden = buildDiscardAssistant(state)
    expect(hidden.knownTiles).toBe(14)

    const visibleFive = take(state.wall, '5条')[0]
    state.players[1].discards.push(visibleFive)
    const revealed = buildDiscardAssistant(state)
    expect(revealed.knownTiles).toBe(15)
    expect(revealed.opportunity).toBe(7)
    expect(countKnownCopies(revealed, { type: '条', value: 5 })).toBe(1)
  })

  it('胡牌后亮出的手牌计入已知牌，未胡玩家的暗牌仍然保密', () => {
    const state = fixture()
    state.players[1].hand = take(state.wall, '123456789筒 1234条')
    state.players[2].hand = take(state.wall, '23456789万 678条 11筒')
    state.players[1].hasWon = true

    const analysis = buildDiscardAssistant(state)
    expect(analysis.knownTiles).toBe(27)
    expect(analysis.unknownTiles).toBe(81)
    expect(countKnownCopies(analysis, { type: '筒', value: 9 })).toBe(1)
    expect(countKnownCopies(analysis, { type: '条', value: 6 })).toBe(0)
  })

  it('定缺阶段只给定缺建议，不伪造胡牌概率', () => {
    const state = createInitialGame(42)
    const analysis = buildDiscardAssistant(state)
    expect(analysis.recommendation?.type).toBe('dingque')
    expect(analysis.nextDrawWinProbability).toBeNull()
  })
})
