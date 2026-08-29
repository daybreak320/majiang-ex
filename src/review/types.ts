import type { PlayerId, TileInstance } from '../game/types'
import type { Tile, TileType } from '../types'

/** 复盘问题分类（对应 PRD 8.4 决策评估：牌效 / 攻防 / 鸣牌） */
export type ReviewIssueKind = 'tileEfficiency' | 'attackDefense' | 'strongCombo' | 'meld'

/**
 * 某一次出牌的完整诊断记录。
 * 来源：从事件流中提取 tile_discarded 事件 + 其后的状态快照，重建出牌前 14 张手牌后评估。
 */
export interface DiscardDecision {
  /** 关联的 tile_discarded 事件序号 */
  sequence: number
  playerId: PlayerId
  /** 打出的牌 */
  tile: TileInstance
  /** 出牌前手牌（重建，含被打出的牌；副露状态下 < 14 张） */
  handBefore: TileInstance[]
  /** 出牌后手牌（快照中的 13 张或更少） */
  handAfter: TileInstance[]
  /** 可见牌（全部玩家牌河 + 鸣牌），用于机会数扣减与熟张判断 */
  visible: Tile[]
  dingque: TileType | null
  /**
   * 是否可做机会数评估。
   * 机会数口径假设 14 张无副露手牌（复用 isWinningHand 判定）；碰/杠后手牌 < 14 张时不评估。
   */
  evaluable: boolean
  /** 实际打出后的机会数 */
  opportunityActual: number
  /** 同约束下最优出牌的机会数 */
  opportunityBest: number
  /** 机会数损失 = best - actual */
  opportunityLoss: number
  /** 达到最优机会数的候选牌 */
  bestTiles: TileInstance[]
  /** 防守安全分（0-1，越高越安全） */
  safety: number
  /** 是否尾盘（牌墙剩余 ≤ 40 张） */
  isLateGame: boolean
  /** 是否定缺强制出牌（手牌仍含缺门牌，只能在缺门内选择） */
  isForcedDingque: boolean
  /** 被拆掉的强组合（27/37/38） */
  brokenCombos: ReadonlyArray<readonly [number, number]>
  /** 实战选择后的活张明细，用于教学解释 */
  actualWaits: Array<{ tile: Tile, remaining: number }>
  /** 最优方案的活张明细，用于对比学习 */
  bestWaits: Array<{ tile: Tile, remaining: number }>
  /** 作出该决策时的牌墙余量 */
  wallTiles: number
}

/** 一条复盘问题 */
export interface ReviewIssue {
  kind: ReviewIssueKind
  /** 严重度 1-5，5 最严重 */
  severity: number
  title: string
  detail: string
  sequence: number
}

/** 一条优秀决策（亮点） */
export interface ReviewHighlight {
  title: string
  detail: string
  sequence: number
  opportunity: number
}

/** 整局复盘报告（PRD 12.3：2 个主要问题 + 1 个优秀决策） */
export interface ReviewReport {
  playerId: PlayerId
  /** 全部出牌决策及诊断 */
  decisions: DiscardDecision[]
  /** 全部问题，按严重度降序 */
  issues: ReviewIssue[]
  /** 全部亮点，按机会数降序 */
  highlights: ReviewHighlight[]
  stats: {
    decisions: number
    totalLoss: number
    averageLoss: number
    /** 每手实际机会数序列（趋势） */
    opportunityTrend: number[]
  }
  summary: {
    /** 主要问题（≤ 2） */
    majorIssues: ReviewIssue[]
    /** 优秀决策（至多 1 个） */
    goodDecision: ReviewHighlight | null
  }
}
