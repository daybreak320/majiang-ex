import type { GameEvent, GameStateSnapshot, PlayerId, TileInstance } from '../game/types'
import type { Tile, TileType } from '../types'
import type { DiscardDecision, ReviewHighlight, ReviewIssue, ReviewReport } from './types'
import {
  brokenStrongCombos,
  countOpportunities,
  safetyScore,
} from '../knowledge/mahjongTheory'

export const REVIEW_ALGORITHM_VERSION = 'zhuyang-opportunity-v1'

/** 机会数损失阈值：损失 ≥ 4 个有效进张即判定为牌效失误（朱扬：机会数是牌效核心指标） */
export const LOSS_THRESHOLD = 4
/** 防守安全分低于该值视为危险牌（3/6/9 线非熟张） */
export const DANGER_THRESHOLD = 0.5
/** 牌墙剩余 ≤ 该值视为尾盘（初始 108 张，4 家各 13 张后剩 56 张） */
export const LATE_GAME_WALL = 40
/** 机会数 ≥ 该值视为优秀决策（朱扬：两头听最大 8） */
export const HIGHLIGHT_MIN_OPPORTUNITY = 8

const tileLabel = (tile: Tile) => `${tile.type}${tile.value}`

function isShouZhang(visible: readonly Tile[], tile: Tile): boolean {
  return visible.some(candidate => candidate.type === tile.type && candidate.value === tile.value)
}

/** 受定缺约束的可打候选：手牌仍含缺门牌时，只能在缺门内选择（血战到底规则） */
function legalDiscardCandidates(hand: readonly TileInstance[], dingque: TileType | null): TileInstance[] {
  if (dingque === null)
    return [...hand]
  const forced = hand.filter(tile => tile.type === dingque)
  return forced.length > 0 ? forced : [...hand]
}

/**
 * 分析一次出牌决策：重建出牌前手牌，对比实际选择与同约束下的最优选择。
 * @param snapshot 出牌后的状态快照（命令末事件内嵌）
 * @param playerId 出牌玩家
 * @param discarded 打出的牌
 * @param sequence 关联的 tile_discarded 事件序号
 */
export function analyzeDiscardDecision(
  snapshot: GameStateSnapshot,
  playerId: PlayerId,
  discarded: TileInstance,
  sequence: number,
): DiscardDecision {
  const player = snapshot.players[playerId]
  const handBefore = [...player.hand, discarded]
  const handAfter = player.hand
  const visible: Tile[] = snapshot.players.flatMap(opponent =>
    [...opponent.discards, ...opponent.melds.flatMap(meld => meld.tiles)])
  const dingque = player.dingque
  const evaluable = handBefore.length === 14 && player.melds.length === 0
  const isForcedDingque = dingque !== null && handBefore.some(tile => tile.type === dingque)

  const opportunityOf = (tile: TileInstance): number =>
    countOpportunities(
      handBefore.filter(candidate => candidate.id !== tile.id),
      visible,
      { dingque },
    ).total

  let opportunityBest = 0
  let bestTiles: TileInstance[] = []
  if (evaluable) {
    for (const candidate of legalDiscardCandidates(handBefore, dingque)) {
      const total = opportunityOf(candidate)
      if (total > opportunityBest) {
        opportunityBest = total
        bestTiles = [candidate]
      }
      else if (total === opportunityBest) {
        bestTiles.push(candidate)
      }
    }
  }
  const opportunityActual = evaluable ? opportunityOf(discarded) : 0

  const isLateGame = snapshot.wall.length <= LATE_GAME_WALL
  const safety = safetyScore(discarded.value, isShouZhang(visible, discarded), isLateGame)
  const combos = brokenStrongCombos(handBefore, discarded)

  return {
    sequence,
    playerId,
    tile: discarded,
    handBefore,
    handAfter,
    visible,
    dingque,
    evaluable,
    opportunityActual,
    opportunityBest,
    opportunityLoss: Math.max(0, opportunityBest - opportunityActual),
    bestTiles,
    safety,
    isLateGame,
    isForcedDingque,
    brokenCombos: combos,
  }
}

/** 从事件流提取目标玩家全部出牌决策点（tile_discarded + 其命令末事件的状态快照） */
export function extractDecisions(events: readonly GameEvent[], playerId: PlayerId = 0): DiscardDecision[] {
  const decisions: DiscardDecision[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type !== 'tile_discarded' || event.playerId !== playerId)
      continue
    const snapshotEvent = events.slice(index + 1).find(candidate => candidate.state !== undefined)
    if (snapshotEvent?.state === undefined)
      continue
    decisions.push(analyzeDiscardDecision(snapshotEvent.state, playerId, event.tile, event.sequence))
  }
  return decisions
}

function bestTilesLabel(decision: DiscardDecision): string {
  const labels = [...new Set(decision.bestTiles.map(tileLabel))]
  const shown = labels.slice(0, 2).join('、')
  return labels.length > 2 ? `${shown} 等` : shown
}

/** 从全部决策聚合问题与亮点（PRD 12.3：启发式近似，输出 2 主要问题 + 1 优秀决策） */
export function buildReport(playerId: PlayerId, decisions: readonly DiscardDecision[]): ReviewReport {
  const issues: ReviewIssue[] = []
  const highlights: ReviewHighlight[] = []

  for (const decision of decisions) {
    if (decision.evaluable && decision.opportunityLoss >= LOSS_THRESHOLD) {
      const severity = decision.opportunityLoss >= 8 ? 5 : decision.opportunityLoss >= 6 ? 4 : 3
      issues.push({
        kind: 'tileEfficiency',
        severity,
        title: `机会数损失 ${decision.opportunityLoss}：打出 ${tileLabel(decision.tile)}`,
        detail: `出牌后机会数 ${decision.opportunityActual}，同约束下最优可到 ${decision.opportunityBest}（打 ${bestTilesLabel(decision)}）。机会数是有效进张数，损失越多听牌越慢。`,
        sequence: decision.sequence,
      })
    }
    if (!decision.isForcedDingque && decision.brokenCombos.length > 0) {
      const combos = decision.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')
      issues.push({
        kind: 'strongCombo',
        severity: 4,
        title: `拆掉强组合 ${combos}`,
        detail: `打出 ${tileLabel(decision.tile)} 破坏了 ${combos} 组合。27/37/38 只用两张牌连接 1-9 全部数字，是效率最高的结构，非必要不拆。`,
        sequence: decision.sequence,
      })
    }
    if (!decision.isForcedDingque && decision.isLateGame && decision.safety < DANGER_THRESHOLD) {
      issues.push({
        kind: 'attackDefense',
        severity: 2,
        title: `尾盘打出危险牌 ${tileLabel(decision.tile)}`,
        detail: '3/6/9 线最易被吃碰，中盘后宜跟打熟张或踩 1/4/7 安全线。',
        sequence: decision.sequence,
      })
    }
    if (decision.evaluable && decision.opportunityLoss === 0 && decision.opportunityActual >= HIGHLIGHT_MIN_OPPORTUNITY) {
      highlights.push({
        title: `打出 ${tileLabel(decision.tile)} 后机会数 ${decision.opportunityActual}（最优）`,
        detail: '选择了机会数最大的出牌，保留最强进张结构。',
        sequence: decision.sequence,
        opportunity: decision.opportunityActual,
      })
    }
  }

  issues.sort((a, b) => b.severity - a.severity || a.sequence - b.sequence)
  highlights.sort((a, b) => b.opportunity - a.opportunity || a.sequence - b.sequence)

  const totalLoss = decisions.reduce((sum, decision) => sum + decision.opportunityLoss, 0)
  return {
    playerId,
    decisions: [...decisions],
    issues,
    highlights,
    stats: {
      decisions: decisions.length,
      totalLoss,
      averageLoss: decisions.length === 0 ? 0 : totalLoss / decisions.length,
      opportunityTrend: decisions.map(decision => decision.opportunityActual),
    },
    summary: {
      majorIssues: issues.slice(0, 2),
      goodDecision: highlights[0] ?? null,
    },
  }
}

/** 复盘入口：输入完整牌局事件流，输出 2 个主要问题 + 1 个优秀决策 */
export function analyzeGame(events: readonly GameEvent[], playerId: PlayerId = 0): ReviewReport {
  return buildReport(playerId, extractDecisions(events, playerId))
}
