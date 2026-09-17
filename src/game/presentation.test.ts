import type { GameEvent, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { buildReport } from '../review/analyzer'
import { createInitialGame, recommendDingque } from './core'
import { executeCommand } from './engine'
import { buildEventTimeline, buildGameReview, buildSettlementSummary, buildSpecialTrainingReview, buildTableMood, buildTheoryHistoryEntry, formatAIBehaviorTag, formatGameEvent, formatWinFanBadge, formatWinFanDetail, recommendTraining } from './presentation'

function transfer(sequence: number, from: 0 | 1 | 2 | 3, to: 0 | 1 | 2 | 3, amount: number, reason: Extract<GameEvent, { type: 'score_transferred' }>['reason']): Extract<GameEvent, { type: 'score_transferred' }> {
  return { sequence, type: 'score_transferred', from, to, amount, reason, sourceEventSequence: sequence }
}

describe('结算页投影', () => {
  it('按最终分数生成稳定排名并按终局开始事件分段流水', () => {
    const state = createInitialGame(9)
    state.phase = 'finished'
    state.endReason = 'wall_empty'
    state.players[0].score = 5
    state.players[1].score = 5
    state.players[2].score = -2
    state.players[3].score = -8
    state.events = [
      transfer(1, 2, 0, 2, 'kong'),
      { sequence: 2, type: 'final_settlement_started' },
      transfer(3, 3, 1, 4, 'ready_compensation'),
      { sequence: 4, type: 'final_settlement_completed' },
      { sequence: 5, type: 'game_finished', reason: 'wall_empty' },
    ]

    const summary = buildSettlementSummary(state)
    expect(summary.players.map(player => player.rank)).toEqual([1, 2, 3, 4])
    expect(summary.instantTransfers.map(event => event.sequence)).toEqual([1])
    expect(summary.finalTransfers.map(event => event.sequence)).toEqual([3])
    expect(summary.readyTransfers.map(event => event.sequence)).toEqual([3])
    expect(summary.readyTransfers[0]).toMatchObject({ from: 3, to: 1, amount: 4 })
    expect(summary.endReason).toContain('牌墙')
  })

  it('为最后十张专项输出活张与安全退路的逐题结论', () => {
    const state = createInitialGame(33)
    state.phase = 'finished'
    state.endReason = 'wall_empty'
    const report = buildReport(0, [])
    const review = buildSpecialTrainingReview(state, 'endgame-count', report)

    expect(review.objective).toContain('公开河牌扣张')
    expect(review.outcome).toContain('牌墙已尽')
    expect(review.nextPractice).toContain('哪几张已死')
  })

  it('生成关键事件和完整事件时间线且不修改原事件', () => {
    const state = createInitialGame(11)
    const tile = state.players[0].hand[0]
    state.events = [
      { sequence: 1, type: 'dingque_selected', playerId: 0, tileType: '万' },
      { sequence: 2, type: 'tile_drawn', playerId: 1, tile, replacement: true, lastTile: false },
      { sequence: 3, type: 'response_chosen', playerId: 2, choice: { type: 'gang' } },
      { sequence: 4, type: 'tile_discarded', playerId: 0, tile },
      { sequence: 5, type: 'response_settled', outcome: 'robbedKong', actors: [1] },
      { sequence: 6, type: 'game_finished', reason: 'three_winners' },
    ]
    const events = structuredClone(state.events)

    expect(buildEventTimeline(state).map(item => item.sequence)).toEqual([1, 4, 6])
    expect(buildEventTimeline(state, true)).toHaveLength(state.events.length)
    expect(buildEventTimeline(state, true).map(item => item.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(formatGameEvent(state.events[1])).toContain('杠后补张')
    expect(formatGameEvent(state.events[2])).toBe('搞死搞残选择杠')
    expect(formatGameEvent(state.events[4])).toBe('抢杠胡成立')
    expect(formatGameEvent(state.events[5])).toContain('三家已胡')
    expect(state.events).toEqual(events)
  })

  it('依据公开状态输出局势温度与 AI 行为标签', () => {
    const state = createInitialGame(12)
    const tile = state.players[1].hand[0]
    state.players[1].aiStyle = 'efficient'
    state.events = [{ sequence: 1, type: 'tile_discarded', playerId: 1, tile }]

    expect(buildTableMood(state)).toMatchObject({ stage: '开局塑形', threat: '平稳' })
    expect(formatAIBehaviorTag(state, state.events[0])).toContain('两面与速度优先')

    state.wall = state.wall.slice(0, 16)
    state.players[2].melds = [{ kind: 'peng', tiles: [tile, tile, tile], fromPlayer: 1 }]
    expect(buildTableMood(state)).toMatchObject({ stage: '尾盘决战', threat: '危险' })
  })

  it('基于命令检查点生成不使用未来信息的关键决策复盘', () => {
    const initial = createInitialGame(960)
    const recommended = recommendDingque(initial.players[0].hand)
    const result = executeCommand(initial, { type: 'dingque', playerId: 0, tileType: recommended })
    if (!result.ok)
      throw new Error(result.error)

    const review = buildGameReview(result.nextState)
    expect(review.decisions).toHaveLength(1)
    expect(review.decisions[0]).toMatchObject({ title: '定缺选择', rating: '优秀', actual: `定缺${recommended}` })
    expect(review.decisions[0].hand).toEqual(initial.players[0].hand)
    expect(review.decisions[0].hand).not.toBe(initial.players[0].hand)
  })

  it('汇总点炮、三类杠次数与杠分收支', () => {
    const state = createInitialGame(10)
    state.phase = 'finished'
    state.endReason = 'three_winners'
    const tile = state.players[0].hand[0]
    state.players[0].melds = [
      { kind: 'mingGang', tiles: [tile, tile, tile, tile], fromPlayer: 1 },
      { kind: 'buGang', tiles: [tile, tile, tile, tile], fromPlayer: 2 },
      { kind: 'anGang', tiles: [tile, tile, tile, tile], fromPlayer: null },
    ]
    state.events = [
      transfer(1, 1, 0, 2, 'kong'),
      transfer(2, 0, 2, 1, 'kong'),
      { sequence: 3, type: 'player_won', playerId: 2, info: { tile, fromPlayer: 0, kind: 'discard', baseFan: 1, fan: 1, points: 2, special: [] } },
      { sequence: 4, type: 'final_settlement_started' },
    ]

    const player = buildSettlementSummary(state).players[0]
    expect(player.kongCounts).toEqual({ mingGang: 1, buGang: 1, anGang: 1 })
    expect(player).toMatchObject({ kongIncome: 2, kongExpense: 1, dealtIn: 1 })
  })

  it('按近局反复问题推荐对应专项，而不是随机跳题', () => {
    const base = {
      finishedAt: Date.now(),
      seed: 21,
      endReason: '牌墙已摸完',
      score: 0,
      rank: 2,
      hasWon: false,
      winFan: null,
      dealtIn: 0,
      decisionsExcellent: 0,
      decisionsReasonable: 2,
      decisionsImprovable: 1,
    }
    expect(recommendTraining([{ ...base, issues: [{ kind: 'attackDefense', title: '尾盘危险', actual: '打3万', recommended: '打1万', reason: '风险高' }] }])?.kind).toBe('defense-big-hands')
    expect(recommendTraining([{ ...base, issues: [{ kind: 'strongCombo', title: '拆搭子', actual: '打2条', recommended: '打9万', reason: '拆强组合' }] }])?.kind).toBe('attack-qingyise')
    expect(recommendTraining([{ ...base, issues: [{ kind: 'tileEfficiency', title: '路线变窄', actual: '打4筒', recommended: '打9万', reason: '活张更少' }] }])?.kind).toBe('endgame-count')
  })

  it('近三局历史摘要使用破晓哥理论报告并记录评估版本', () => {
    const state = createInitialGame(12)
    state.phase = 'finished'
    state.endReason = 'wall_empty'
    const report = buildReport(0, [])
    const entry = buildTheoryHistoryEntry(state, report)
    expect(entry.reviewAlgorithmVersion).toBe('zhuyang-opportunity-v1')
    expect(entry.decisionsExcellent).toBe(0)
    expect(entry.decisionsReasonable).toBe(0)
    expect(entry.decisionsImprovable).toBe(0)
  })
})

describe('结算页 · 查叫解释', () => {
  function tile(type: TileInstance['type'], value: number, id: string): TileInstance {
    return { id, type, value }
  }

  function finishedState(seed: number) {
    const state = createInitialGame(seed)
    state.phase = 'finished'
    state.endReason = 'wall_empty'
    state.events = []
    return state
  }

  it('未胡几家全是花猪时说明不产生查叫的原因', () => {
    const state = finishedState(5)
    state.players.forEach((player, index) => {
      player.dingque = '万'
      player.hand = [tile('万', 1, `pig-${index}`), ...player.hand.slice(0, 12)]
    })

    const summary = buildSettlementSummary(state)
    expect(summary.readyTransfers).toEqual([])
    expect(summary.players.map(player => player.finalState)).toEqual(['flowerPig', 'flowerPig', 'flowerPig', 'flowerPig'])
    expect(summary.readyCheckNote).toContain('花猪')
  })

  it('未胡几家都没下叫时明确说明没有叫口可收赔', () => {
    const scattered: [TileInstance['type'], number][] = [
      ['条', 1],
      ['条', 2],
      ['条', 4],
      ['条', 5],
      ['条', 7],
      ['条', 8],
      ['筒', 1],
      ['筒', 2],
      ['筒', 4],
      ['筒', 5],
      ['筒', 7],
      ['筒', 8],
      ['条', 9],
    ]
    const state = finishedState(7)
    state.players.forEach((player, index) => {
      player.dingque = '万'
      player.hand = scattered.map(([type, value], order) => tile(type, value, `scatter-${index}-${order}`))
    })

    const summary = buildSettlementSummary(state)
    expect(summary.players.every(player => player.finalState === 'notReady')).toBe(true)
    expect(summary.readyTransfers).toEqual([])
    expect(summary.readyCheckNote).toContain('都没下叫')
  })

  it('只有花猪未听时提示花猪走花猪赔付、不再另算查叫', () => {
    const state = finishedState(6)
    state.players.forEach((player, index) => {
      player.dingque = '万'
      if (index === 1)
        return
      player.hand = [tile('万', 2, `pig-${index}`)]
    })
    state.players[1].hand = [
      tile('条', 1, 'ready-1'),
      tile('条', 1, 'ready-2'),
      tile('条', 1, 'ready-3'),
      tile('条', 2, 'ready-4'),
      tile('条', 3, 'ready-5'),
      tile('条', 4, 'ready-6'),
      tile('条', 5, 'ready-7'),
      tile('条', 6, 'ready-8'),
      tile('条', 7, 'ready-9'),
      tile('条', 8, 'ready-10'),
      tile('条', 8, 'ready-11'),
      tile('条', 8, 'ready-12'),
      tile('条', 9, 'ready-13'),
    ]

    const summary = buildSettlementSummary(state)
    expect(summary.players[1].finalState).toBe('ready')
    expect(summary.players[1].readyWaits).toContain('9条')
    expect(summary.players[1].highestPoints).toBeGreaterThan(0)
    expect(summary.readyTransfers).toEqual([])
    expect(summary.readyCheckNote).toContain('花猪')
  })

  it('已胡玩家的终局状态标记为已胡', () => {
    const state = finishedState(8)
    state.players[2].hasWon = true

    const summary = buildSettlementSummary(state)
    expect(summary.players[2].finalState).toBe('won')
    expect(summary.players[2].readyWaits).toEqual([])
    expect(summary.players[2].highestPoints).toBe(0)
  })
})

describe('番数出处', () => {
  it('海底捞月在徽标与明细中可见，能看出基础番与加番', () => {
    const badge = formatWinFanBadge({ baseFan: 2, fan: 3, special: ['selfDraw', 'lastTileDraw'] })
    expect(badge).toContain('3番')
    expect(badge).toContain('海底捞月')

    const detail = formatWinFanDetail({ baseFan: 2, fan: 3, special: ['selfDraw', 'lastTileDraw'] })
    expect(detail).toContain('基础 2')
    expect(detail).toContain('海底捞月 1')
    expect(detail).toContain('= 3番')
    expect(detail).toContain('自摸')
  })

  it('撞到封顶时明确说明不再涨番', () => {
    const detail = formatWinFanDetail({ baseFan: 4, fan: 5, special: ['selfDraw', 'lastTileDraw'] })
    expect(detail).toContain('封顶')
    expect(detail).toContain('= 5番')
    expect(formatWinFanBadge({ baseFan: 4, fan: 5, special: ['selfDraw', 'lastTileDraw'] })).toContain('封顶')
  })

  it('未胡与普通点炮胡的兜底文案', () => {
    expect(formatWinFanDetail(null)).toBe('未胡')
    expect(formatWinFanBadge(null)).toBe('0番')
    expect(formatWinFanDetail({ baseFan: 1, fan: 1, special: [] })).toContain('点炮胡')
  })

  it('结算页投影（缺 baseFan）也能按 总番-加番 推回基础番', () => {
    const detail = formatWinFanDetail({ baseFan: null, fan: 3, special: ['lastTileDiscard'] })
    expect(detail).toContain('基础 2')
    expect(detail).toContain('海底炮 1')
  })
})
