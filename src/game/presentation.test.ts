import type { GameEvent } from './types'
import { describe, expect, it } from 'vitest'
import { buildReport } from '../review/analyzer'
import { createInitialGame, recommendDingque } from './core'
import { executeCommand } from './engine'
import { buildEventTimeline, buildGameReview, buildSettlementSummary, buildSpecialTrainingReview, buildTableMood, buildTheoryHistoryEntry, formatAIBehaviorTag, formatGameEvent, recommendTraining } from './presentation'

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
      { sequence: 3, type: 'player_won', playerId: 2, info: { tile, fromPlayer: 0, kind: 'discard', fan: 1, points: 2, special: [] } },
      { sequence: 4, type: 'final_settlement_started' },
    ]

    const player = buildSettlementSummary(state).players[0]
    expect(player.kongCounts).toEqual({ mingGang: 1, buGang: 1, anGang: 1 })
    expect(player).toMatchObject({ kongIncome: 2, kongExpense: 1, dealtIn: 1 })
  })

  it('按近局反复问题推荐对应专项，而不是随机跳题', () => {
    const base = {
      finishedAt: Date.now(), seed: 21, endReason: '牌墙已摸完', score: 0, rank: 2, hasWon: false, winFan: null,
      dealtIn: 0, decisionsExcellent: 0, decisionsReasonable: 2, decisionsImprovable: 1,
    }
    expect(recommendTraining([{ ...base, issues: [{ kind: 'attackDefense', title: '尾盘危险', actual: '打3万', recommended: '打1万', reason: '风险高' }] }])?.kind).toBe('defense-big-hands')
    expect(recommendTraining([{ ...base, issues: [{ kind: 'strongCombo', title: '拆搭子', actual: '打2条', recommended: '打9万', reason: '拆强组合' }] }])?.kind).toBe('attack-qingyise')
    expect(recommendTraining([{ ...base, issues: [{ kind: 'tileEfficiency', title: '路线变窄', actual: '打4筒', recommended: '打9万', reason: '活张更少' }] }])?.kind).toBe('endgame-count')
  })

  it('近三局历史摘要使用朱扬理论报告并记录评估版本', () => {
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
