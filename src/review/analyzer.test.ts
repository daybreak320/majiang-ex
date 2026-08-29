import type { GameStateSnapshot, PlayerId, PlayerState, TileInstance } from '../game/types'
import type { TileType } from '../types'
import type { DiscardDecision } from './types'
import { describe, expect, it } from 'vitest'
import { runAIGame } from '../game/ai'
import {
  analyzeDiscardDecision,
  analyzeGame,
  buildReport,
  DANGER_THRESHOLD,
} from './analyzer'

let idCounter = 0
function tile(type: TileType, value: number): TileInstance {
  return { id: `t${idCounter++}`, type, value }
}

/** 解析 '123456789万 55万 3条 4条 4条' 形式的记谱 */
function parseHand(notation: string): TileInstance[] {
  const result: TileInstance[] = []
  const pattern = /(\d+)([万条筒])/g
  let match: RegExpExecArray | null = pattern.exec(notation)
  while (match !== null) {
    const type = match[2] as TileType
    for (const digit of match[1].split('')) {
      result.push(tile(type, Number(digit)))
    }
    match = pattern.exec(notation)
  }
  return result
}

function emptyPlayer(id: PlayerId, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    hand: [],
    discards: [],
    melds: [],
    score: 0,
    dingque: null,
    hasWon: false,
    winInfo: null,
    passedWinValue: null,
    aiStyle: 'efficient',
    ...overrides,
  }
}

/** 构造出牌后的状态快照：handBefore 中扣除 discarded 即快照手牌 */
function makeSnapshot(
  handBefore: TileInstance[],
  discarded: TileInstance,
  opts: { wallLength?: number, dingque?: TileType | null, visibleDiscards?: TileInstance[] } = {},
): GameStateSnapshot {
  const { wallLength = 50, dingque = null, visibleDiscards = [] } = opts
  return {
    rulesVersion: 'm1.1',
    seed: 1,
    phase: 'discarding',
    players: [
      emptyPlayer(0, { hand: handBefore.filter(t => t.id !== discarded.id), dingque }),
      emptyPlayer(1, { discards: visibleDiscards }),
      emptyPlayer(2),
      emptyPlayer(3),
    ],
    wall: Array.from({ length: wallLength }, (_, i) => tile('万', (i % 9) + 1)),
    dealer: 0,
    currentPlayer: 0,
    lastDrawnTileId: null,
    lastDrawWasReplacement: false,
    lastDrawWasLastTile: false,
    responseWindow: null,
    kongContext: null,
    endReason: null,
  }
}

/** 牌例：123456789万 55万 3条 4条 4条 —— 打 4条 保留 34 两头搭（机会数 8），打 3条 剩 55 将+44 对（听 4条×2 + 5万×1 = 机会数 3） */
const EFFICIENCY_HAND = '123456789万 55万 3条 4条 4条'

describe('analyzeDiscardDecision · 牌效（机会数）', () => {
  it('打出最优牌 4条：机会数 8，损失 0，进入亮点', () => {
    const hand = parseHand(EFFICIENCY_HAND)
    const discarded = hand.find(t => t.type === '条' && t.value === 4)!
    const decision = analyzeDiscardDecision(makeSnapshot(hand, discarded), 0, discarded, 10)
    expect(decision.evaluable).toBe(true)
    expect(decision.opportunityActual).toBe(8)
    expect(decision.opportunityBest).toBe(8)
    expect(decision.opportunityLoss).toBe(0)
    expect(decision.bestTiles.some(t => t.id === discarded.id)).toBe(true)
    const report = buildReport(0, [decision])
    expect(report.issues).toHaveLength(0)
    expect(report.highlights.some(h => h.sequence === 10)).toBe(true)
  })

  it('打错 3条：机会数 3 vs 最优 8，检出牌效问题（严重度 3）', () => {
    const hand = parseHand(EFFICIENCY_HAND)
    const discarded = hand.find(t => t.type === '条' && t.value === 3)!
    const decision = analyzeDiscardDecision(makeSnapshot(hand, discarded), 0, discarded, 10)
    expect(decision.opportunityActual).toBe(3)
    expect(decision.opportunityBest).toBe(8)
    expect(decision.opportunityLoss).toBe(5)
    const report = buildReport(0, [decision])
    const issue = report.issues.find(i => i.kind === 'tileEfficiency')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe(3)
    expect(issue!.title).toContain('把转和的路打窄了')
    expect(issue!.title).not.toContain('机会数')
    expect(issue!.detail).toContain('牌墙还有 50 张')
    expect(issue!.detail).toContain('活张')
    expect(issue!.detail).not.toContain('机会数')
    expect(report.summary.majorIssues).toContain(issue)
    expect(report.highlights).toHaveLength(0)
  })

  it('可见牌扣减：5条 已见 2 张时机会数从 8 降为 6', () => {
    const hand = parseHand(EFFICIENCY_HAND)
    const discarded = hand.find(t => t.type === '条' && t.value === 4)!
    const visible = [tile('条', 5), tile('条', 5)]
    const decision = analyzeDiscardDecision(
      makeSnapshot(hand, discarded, { visibleDiscards: visible }),
      0,
      discarded,
      10,
    )
    expect(decision.opportunityActual).toBe(6)
  })

  it('损失 8 以上严重度为 5', () => {
    // 打 5万 拆掉 55 将，34条 无法成面子 → 机会数归零
    const hand = parseHand('123456789万 55万 3条 4条 4条')
    const discarded = hand.find(t => t.type === '万' && t.value === 5)!
    const decision = analyzeDiscardDecision(makeSnapshot(hand, discarded), 0, discarded, 10)
    expect(decision.opportunityBest).toBe(8)
    expect(decision.opportunityActual).toBe(0)
    expect(decision.opportunityLoss).toBe(8)
    const report = buildReport(0, [decision])
    const issue = report.issues.find(i => i.kind === 'tileEfficiency')
    expect(issue!.severity).toBe(5)
  })
})

describe('analyzeDiscardDecision · 强组合', () => {
  it('拆掉 3-7 强组合被检出', () => {
    const hand = parseHand('123万 456万 789万 55万 3条 7条 5筒')
    const discarded = hand.find(t => t.type === '条' && t.value === 3)!
    const decision = analyzeDiscardDecision(makeSnapshot(hand, discarded), 0, discarded, 10)
    expect(decision.brokenCombos).toContainEqual([3, 7])
    const report = buildReport(0, [decision])
    expect(report.issues.some(i => i.kind === 'strongCombo')).toBe(true)
  })

  it('定缺强制打缺门牌时不误报强组合问题', () => {
    const hand = parseHand('123万 456万 789万 55万 3条 7条 5筒')
    const discarded = hand.find(t => t.type === '条' && t.value === 3)!
    const decision = analyzeDiscardDecision(
      makeSnapshot(hand, discarded, { dingque: '条' }),
      0,
      discarded,
      10,
    )
    expect(decision.isForcedDingque).toBe(true)
    expect(decision.brokenCombos).toContainEqual([3, 7])
    const report = buildReport(0, [decision])
    expect(report.issues.some(i => i.kind === 'strongCombo')).toBe(false)
  })
})

describe('analyzeDiscardDecision · 攻防', () => {
  it('尾盘打出 3/6/9 危险线非熟张被检出', () => {
    const hand = parseHand('123万 456万 789万 55万 3条 7条 6筒')
    const discarded = hand.find(t => t.type === '筒' && t.value === 6)!
    const decision = analyzeDiscardDecision(
      makeSnapshot(hand, discarded, { wallLength: 20 }),
      0,
      discarded,
      10,
    )
    expect(decision.isLateGame).toBe(true)
    expect(decision.safety).toBeLessThan(DANGER_THRESHOLD)
    const report = buildReport(0, [decision])
    expect(report.issues.some(i => i.kind === 'attackDefense')).toBe(true)
  })

  it('跟下家熟张获得 0.9 安全分，不误报', () => {
    const hand = parseHand('123万 456万 789万 55万 3条 7条 6筒')
    const discarded = hand.find(t => t.type === '筒' && t.value === 6)!
    const visible = [tile('筒', 6)]
    const decision = analyzeDiscardDecision(
      makeSnapshot(hand, discarded, { wallLength: 20, visibleDiscards: visible }),
      0,
      discarded,
      10,
    )
    expect(decision.safety).toBe(0.9)
    const report = buildReport(0, [decision])
    expect(report.issues.some(i => i.kind === 'attackDefense')).toBe(false)
  })
})

describe('buildReport · 2+1 聚合', () => {
  it('输出 2 主要问题 + 1 优秀决策，按严重度排序', () => {
    const hand = parseHand(EFFICIENCY_HAND)
    const bad = hand.find(t => t.type === '条' && t.value === 3)!
    const good = hand.find(t => t.type === '条' && t.value === 4)!
    const decisions: DiscardDecision[] = [
      analyzeDiscardDecision(makeSnapshot(hand, bad), 0, bad, 10),
      analyzeDiscardDecision(makeSnapshot(hand, good), 0, good, 20),
      analyzeDiscardDecision(makeSnapshot(hand, bad), 0, bad, 30),
    ]
    const report = buildReport(0, decisions)
    expect(report.stats.decisions).toBe(3)
    expect(report.stats.totalLoss).toBe(10)
    expect(report.summary.majorIssues).toHaveLength(2)
    expect(report.summary.goodDecision).not.toBeNull()
    expect(report.summary.goodDecision!.sequence).toBe(20)
    expect(report.stats.opportunityTrend).toEqual([3, 8, 3])
  })
})

describe('analyzeGame · 端到端', () => {
  it('从 AI 整局事件流产出完整复盘报告', () => {
    const state = runAIGame(20260820)
    const expectedDiscards = state.events.filter(e => e.type === 'tile_discarded' && e.playerId === 0).length
    const report = analyzeGame(state.events, 0)
    expect(report.stats.decisions).toBe(expectedDiscards)
    expect(report.decisions.length).toBe(report.stats.decisions)
    expect(report.summary.majorIssues.length).toBeLessThanOrEqual(2)
    expect(report.stats.opportunityTrend.length).toBe(report.stats.decisions)
    for (const decision of report.decisions) {
      expect(decision.opportunityLoss).toBeGreaterThanOrEqual(0)
    }
  })

  it('多 seed 整局模拟可稳定产出报告', () => {
    for (const seed of [1, 42, 777, 2024]) {
      const state = runAIGame(seed)
      const report = analyzeGame(state.events, 0)
      expect(report.stats.decisions).toBeGreaterThan(0)
      expect(report.summary.majorIssues.length).toBeLessThanOrEqual(2)
    }
  })
})
