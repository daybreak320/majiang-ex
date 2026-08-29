import type { GameEvent, GameStateSnapshot, PlayerId, TileInstance } from '../game/types'
import type { Tile, TileType } from '../types'
import type { DiscardDecision, ReviewHighlight, ReviewIssue, ReviewReport } from './types'
import {
  assessDiscardSafety,
  brokenStrongCombos,
  countOpportunities,
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

  const opportunityOf = (tile: TileInstance) =>
    countOpportunities(
      handBefore.filter(candidate => candidate.id !== tile.id),
      visible,
      { dingque },
    )

  let opportunityBest = 0
  let bestTiles: TileInstance[] = []
  let bestWaits: Array<{ tile: Tile, remaining: number }> = []
  if (evaluable) {
    for (const candidate of legalDiscardCandidates(handBefore, dingque)) {
      const result = opportunityOf(candidate)
      if (result.total > opportunityBest) {
        opportunityBest = result.total
        bestTiles = [candidate]
        bestWaits = result.waits
      }
      else if (result.total === opportunityBest) {
        bestTiles.push(candidate)
      }
    }
  }
  const actualResult = evaluable ? opportunityOf(discarded) : { total: 0, waits: [] }
  const opportunityActual = actualResult.total

  const isLateGame = snapshot.wall.length <= LATE_GAME_WALL
  const upper = snapshot.players[(playerId + 3) % 4 as PlayerId]
  const opposite = snapshot.players[(playerId + 2) % 4 as PlayerId]
  const lower = snapshot.players[(playerId + 1) % 4 as PlayerId]
  const activeOpponents = snapshot.players.filter(opponent => opponent.id !== playerId && !opponent.hasWon)
  const wasDiscarded = (opponent: typeof upper) => opponent.discards
    .some(tile => tile.type === discarded.type && tile.value === discarded.value)
  // 来源：成都册第二章第三节、第三章“进攻、防守与综合”及“实用小技巧”。
  const safety = assessDiscardSafety({
    value: discarded.value,
    isLateGame,
    familiarBy: {
      upper: wasDiscarded(upper),
      opposite: wasDiscarded(opposite),
      lower: wasDiscarded(lower),
    },
    opponentMeldCount: activeOpponents.reduce((sum, opponent) => sum + opponent.melds.length, 0),
    sameSuitOpponentMeldCount: activeOpponents.reduce((sum, opponent) =>
      sum + opponent.melds.filter(meld => meld.tiles[0]?.type === discarded.type).length, 0),
    dingqueOpponentCount: activeOpponents.filter(opponent => opponent.dingque === discarded.type).length,
  }).score
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
    actualWaits: actualResult.waits,
    bestWaits,
    wallTiles: snapshot.wall.length,
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

function waitsLabel(waits: readonly { tile: Tile, remaining: number }[]): string {
  if (waits.length === 0)
    return '尚未形成活叫'
  return waits.slice(0, 5).map(wait => `${tileLabel(wait.tile)}×${wait.remaining}`).join('、') + (waits.length > 5 ? ' 等' : '')
}

function paceLabel(liveTiles: number): string {
  if (liveTiles >= 8)
    return '转和的路很宽'
  if (liveTiles >= 4)
    return '还有可用的追赶空间'
  if (liveTiles > 0)
    return '路已经很窄'
  return '已经没有可兑现的活叫'
}

function publicSituation(decision: DiscardDecision): string {
  const phase = decision.isLateGame ? `牌墙只剩 ${decision.wallTiles} 张，已进入尾盘` : `当时牌墙还有 ${decision.wallTiles} 张，仍可优先争取速度`
  if (decision.isForcedDingque)
    return `${phase}，而且手里还留着定缺门，这一手属于规则强制清缺，不能按普通取舍判错。`
  return `${phase}。`
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
        title: `这一手把转和的路打窄了：${tileLabel(decision.tile)}`,
        detail: `${publicSituation(decision)} 你打出 ${tileLabel(decision.tile)} 后，实战只留下 ${decision.opportunityActual} 张可兑现的活张（${waitsLabel(decision.actualWaits)}），${paceLabel(decision.opportunityActual)}；如果改打 ${bestTilesLabel(decision)}，还能保留 ${decision.opportunityBest} 张活张（${waitsLabel(decision.bestWaits)}）。这不是单纯“少几张牌”，而是把原本更容易摸到、也更容易尽快听牌的路线拆窄了。下次先比较各候选打完后留下的叫口和剩余张数，再决定谁该先走。`,
        sequence: decision.sequence,
      })
    }
    if (!decision.isForcedDingque && decision.brokenCombos.length > 0) {
      const combos = decision.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')
      issues.push({
        kind: 'strongCombo',
        severity: 4,
        title: `拆掉强组合 ${combos}`,
        detail: `${publicSituation(decision)} 打出 ${tileLabel(decision.tile)} 后，把 ${combos} 这组原本能同时接住多种来牌的搭子拆开了。它看着只是两张边张，实际却给后续成搭留了很多接口；局面没有逼你清缺或防守时，先处理更孤立的牌会稳得多。`,
        sequence: decision.sequence,
      })
    }
    if (!decision.isForcedDingque && decision.isLateGame && decision.safety < DANGER_THRESHOLD) {
      issues.push({
        kind: 'attackDefense',
        severity: 2,
        title: `尾盘打出危险牌 ${tileLabel(decision.tile)}`,
        detail: `${publicSituation(decision)} 此时打出 ${tileLabel(decision.tile)} 既不是桌上已经反复出现的熟张，也没有明显的安全依据；在别人已经有副露、牌局收紧时，这种生张比继续做一点牌更容易出事。若手牌仍有替代，优先跟着已出现过的牌走，先把放铳风险压下来。`,
        sequence: decision.sequence,
      })
    }
    if (decision.evaluable && decision.opportunityLoss === 0 && decision.opportunityActual >= HIGHLIGHT_MIN_OPPORTUNITY) {
      highlights.push({
        title: `这手把最快的转和路线留住了：${tileLabel(decision.tile)}`,
        detail: `${publicSituation(decision)} 打出 ${tileLabel(decision.tile)} 后仍保留 ${decision.opportunityActual} 张活张（${waitsLabel(decision.actualWaits)}），${paceLabel(decision.opportunityActual)}。你没有为了眼前的孤张或小结构去拆掉更宽的叫口，速度判断是对的。`,
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
