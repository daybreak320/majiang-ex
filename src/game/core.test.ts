import type { TileType } from '../types'
import type { TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import {
  chooseTimeoutDiscard,
  createInitialGame,
  createSeededRandom,
  createTileSet,
  getLegalDiscards,
  recommendDingque,
  shuffleTiles,
  sortTiles,
} from './core'

function tiles(specification: string): TileInstance[] {
  let id = 0
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map(value => ({ id: `test-${id++}`, type, value: Number(value) }))
  })
}

describe('牌组与开局', () => {
  it('创建万条筒 1-9 各四张且实体 id 唯一', () => {
    const set = createTileSet()
    expect(set).toHaveLength(108)
    expect(new Set(set.map(tile => tile.id))).toHaveLength(108)
    for (const type of ['万', '条', '筒'] as const) {
      for (let value = 1; value <= 9; value++)
        expect(set.filter(tile => tile.type === type && tile.value === value)).toHaveLength(4)
    }
  })

  it('相同 seed 产生相同洗牌和开局', () => {
    const set = createTileSet()
    expect(shuffleTiles(set, createSeededRandom(960))).toEqual(shuffleTiles(set, createSeededRandom(960)))
    expect(createInitialGame(960)).toEqual(createInitialGame(960))
  })

  it('发牌后保存完整可回放的初始状态', () => {
    const game = createInitialGame(42)
    expect(game.seed).toBe(42)
    expect(game.rulesVersion).toBe('m1.1')
    expect(game.wall).toHaveLength(55)
    expect(game.currentPlayer).toBe(game.dealer)
    expect(game.events).toEqual([])
    expect(game.players.map(player => player.hand.length)).toEqual(
      game.players.map(player => player.id === game.dealer ? 14 : 13),
    )
    expect(game.players.every(player => player.score === 0)).toBe(true)

    const allIds = [...game.wall, ...game.players.flatMap(player => player.hand)].map(tile => tile.id)
    expect(allIds).toHaveLength(108)
    expect(new Set(allIds)).toHaveLength(108)
    for (const player of game.players)
      expect(player.hand).toEqual(sortTiles(player.hand))
  })

  it('将三种 AI 风格确定性地分配给非用户座位', () => {
    const styles = createInitialGame(7).players.slice(1).map(player => player.aiStyle)
    expect(new Set(styles)).toEqual(new Set(['aggressive', 'steady', 'efficient']))
    expect(createInitialGame(7).players[0].aiStyle).toBeNull()
    expect(createInitialGame(7).players.slice(1).map(player => player.aiStyle)).toEqual(styles)
  })
})

describe('定缺与超时出牌', () => {
  it('有缺门牌时只能打缺门，清空后可打全部牌', () => {
    const hand = tiles('12万 34条 56筒')
    expect(getLegalDiscards(hand, '万').every(tile => tile.type === '万')).toBe(true)
    expect(getLegalDiscards(hand.filter(tile => tile.type !== '万'), '万')).toHaveLength(4)
  })

  it('推荐定缺确定且平局遵循固定花色顺序', () => {
    const hand = tiles('19万 19条 19筒')
    expect(recommendDingque(hand)).toBe('万')
    expect(recommendDingque(hand)).toBe(recommendDingque(hand))
  })

  it('同张数时优先移除结构更差的一门而非只数张数', () => {
    const hand = tiles('123万 159条 456筒')
    expect(recommendDingque(hand)).toBe('条')
  })

  it('摸到的牌合法时优先摸切', () => {
    const hand = tiles('123万 456条 789筒')
    const drawn = hand[hand.length - 1]
    expect(chooseTimeoutDiscard(hand, null, drawn.id)).toBe(drawn)
  })

  it('摸牌受定缺限制时打合法缺门牌且尽量保留对子', () => {
    const hand = tiles('1159万 234条 678筒')
    const drawn = hand.find(tile => tile.type === '条')!
    const discarded = chooseTimeoutDiscard(hand, '万', drawn.id)
    expect(discarded?.type).toBe('万')
    expect(discarded?.value).not.toBe(1)
  })
})
