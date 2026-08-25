import type { TileType } from '../types'
import type { GameEvent, GameState, Meld, PlayerId, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { createInitialGame } from './core'
import { finish } from './engine'
import { analyzeReadyHand, isFlowerPig, settleFinal } from './settlement'

let nextTileId = 1

function tiles(specification: string): TileInstance[] {
  if (specification.trim() === '')
    return []
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map(value => ({ id: `settlement-${nextTileId++}`, type, value: Number(value) }))
  })
}

function meld(kind: Meld['kind'], specification: string): Meld {
  return { kind, tiles: tiles(specification), fromPlayer: null }
}

function fixture(hands: [string, string, string, string]): GameState {
  nextTileId = 1
  const state = createInitialGame(1)
  state.phase = 'discarding'
  state.wall = []
  state.events = []
  state.nextEventSequence = 1
  state.endReason = null
  for (const player of state.players) {
    player.hand = tiles(hands[player.id])
    player.discards = []
    player.melds = []
    player.score = 0
    player.dingque = '筒'
    player.hasWon = false
    player.winInfo = null
  }
  return state
}

function scoreTransfer(
  sequence: number,
  from: PlayerId,
  to: PlayerId,
  amount: number,
  reason: Extract<GameEvent, { type: 'score_transferred' }>['reason'],
): Extract<GameEvent, { type: 'score_transferred' }> {
  return { sequence, type: 'score_transferred', from, to, amount, reason, sourceEventSequence: sequence - 1 }
}

function transfers(state: GameState, reason?: Extract<GameEvent, { type: 'score_transferred' }>['reason']) {
  return state.events.filter((event): event is Extract<GameEvent, { type: 'score_transferred' }> =>
    event.type === 'score_transferred' && (reason === undefined || event.reason === reason),
  )
}

describe('终局听牌分析', () => {
  it('枚举所有合法胡牌并取受封顶约束的最高叫', () => {
    const state = fixture(['5万', '1万', '2万', '3万'])
    state.players[0].melds = [
      meld('anGang', '1111万'),
      meld('anGang', '2222万'),
      meld('anGang', '3333万'),
      meld('anGang', '4444万'),
    ]

    const analysis = analyzeReadyHand(state.players[0])
    expect(analysis.isReady).toBe(true)
    expect(analysis.tiles.map(candidate => `${candidate.tile.value}${candidate.tile.type}`)).toEqual(['5万'])
    expect(analysis.tiles[0].score.scoringFan).toBe(5)
    expect(analysis.highestPoints).toBe(32)
  })

  it('仍持有定缺门牌的花猪必定不是听牌', () => {
    const state = fixture(['123万 456万 789万 11万 23筒', '1万', '2万', '3万'])
    const player = state.players[0]
    expect(isFlowerPig(player)).toBe(true)
    expect(analyzeReadyHand(player)).toEqual({ isReady: false, tiles: [], highestPoints: 0 })
  })
})

describe('终局三阶段结算', () => {
  it('未听仅逐笔退还原杠分，不退胡分或退款事件', () => {
    const state = fixture(['147万 258条', '1万', '2万', '3万'])
    state.events = [
      scoreTransfer(1, 1, 0, 2, 'kong'),
      scoreTransfer(2, 2, 0, 1, 'kong'),
      scoreTransfer(3, 3, 0, 8, 'discard_win'),
      scoreTransfer(4, 0, 1, 2, 'kong_refund'),
    ]
    state.nextEventSequence = 5

    const settlement = settleFinal(state, 99)
    expect(settlement.refunds).toEqual([
      { from: 0, to: 1, amount: 2, reason: 'kong_refund', sourceEventSequence: 1 },
      { from: 0, to: 2, amount: 1, reason: 'kong_refund', sourceEventSequence: 2 },
    ])
  })

  it('多花猪分别向每个活跃非花猪赔付封顶32分', () => {
    const state = fixture(['1筒', '2筒', '147万 258条', '147万 369条'])
    const settlement = settleFinal(state, 7)

    expect(settlement.flowerPigPayments).toHaveLength(4)
    expect(settlement.flowerPigPayments).toEqual(expect.arrayContaining([
      { from: 0, to: 2, amount: 32, reason: 'flower_pig', sourceEventSequence: 7 },
      { from: 0, to: 3, amount: 32, reason: 'flower_pig', sourceEventSequence: 7 },
      { from: 1, to: 2, amount: 32, reason: 'flower_pig', sourceEventSequence: 7 },
      { from: 1, to: 3, amount: 32, reason: 'flower_pig', sourceEventSequence: 7 },
    ]))
  })

  it('每个未听者向多个听牌者分别赔最高叫，花猪可支付但不可收益', () => {
    const state = fixture([
      '147万 258条',
      '123万 456万 789万 11条 23条',
      '5万',
      '123万 456万 789万 11条 23筒',
    ])
    state.players[2].melds = [
      meld('anGang', '1111万'),
      meld('anGang', '2222万'),
      meld('anGang', '3333万'),
      meld('anGang', '4444万'),
    ]

    const settlement = settleFinal(state, 8)
    expect(settlement.readyPayments).toEqual([
      { from: 0, to: 1, amount: 1, reason: 'ready_compensation', sourceEventSequence: 8 },
      { from: 0, to: 2, amount: 32, reason: 'ready_compensation', sourceEventSequence: 8 },
      { from: 3, to: 1, amount: 1, reason: 'ready_compensation', sourceEventSequence: 8 },
      { from: 3, to: 2, amount: 32, reason: 'ready_compensation', sourceEventSequence: 8 },
    ])
    expect(settlement.readyPayments.some(payment => payment.to === 3)).toBe(false)
  })

  it('已胡者完全排除终局支付和收益，包括杠分原支付者', () => {
    const state = fixture(['147万 258条', '123万 456万 789万 11条 23条', '1筒', '2万'])
    state.players[1].hasWon = true
    state.events = [scoreTransfer(1, 1, 0, 2, 'kong')]
    state.nextEventSequence = 2

    const settlement = settleFinal(state, 2)
    expect([...settlement.refunds, ...settlement.flowerPigPayments, ...settlement.readyPayments]
      .some(payment => payment.from === 1 || payment.to === 1)).toBe(false)
  })

  it('finish 严格按开始、退税、花猪、查叫、完成、结束排序且守恒并幂等', () => {
    const state = fixture([
      '147万 258条',
      '123万 456万 789万 11条 23条',
      '1筒',
      '147万 369条',
    ])
    state.events = [scoreTransfer(1, 1, 0, 2, 'kong')]
    state.players[1].score = -2
    state.players[0].score = 2
    state.nextEventSequence = 2

    finish(state, 'wall_empty')
    const settlementEvents = state.events.slice(1)
    const reasons = settlementEvents.map(event => event.type === 'score_transferred' ? event.reason : event.type)
    expect(reasons).toEqual([
      'final_settlement_started',
      'kong_refund',
      'flower_pig',
      'flower_pig',
      'flower_pig',
      'ready_compensation',
      'ready_compensation',
      'ready_compensation',
      'final_settlement_completed',
      'game_finished',
    ])
    expect(state.players.reduce((total, player) => total + player.score, 0)).toBe(0)

    const snapshot = structuredClone(state)
    finish(state, 'three_winners')
    expect(state).toEqual(snapshot)
    expect(settleFinal(state, 999)).toEqual({ refunds: [], flowerPigPayments: [], readyPayments: [] })
  })

  it('三家胡结束仍进入终局流程但唯一活跃玩家不发生转账', () => {
    const state = fixture(['147万', '1筒', '2筒', '3筒'])
    for (const playerId of [1, 2, 3] as const)
      state.players[playerId].hasWon = true

    finish(state, 'three_winners')
    expect(state.events.map(event => event.type)).toEqual([
      'final_settlement_started',
      'final_settlement_completed',
      'game_finished',
    ])
    expect(transfers(state)).toHaveLength(0)
    expect(state).toMatchObject({ phase: 'finished', endReason: 'three_winners' })
  })
})
