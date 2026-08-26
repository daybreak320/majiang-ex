// 朱扬麻将理论 · 教练知识库（代码化）
// 来源：《麻将"机会数"理论与实战》《成都麻将高级打法（升级版）》
// 用途：复盘引擎 / AI 出牌 / 专项训练题生成的启发式理论依据。
// 说明：本模块为启发式近似，不等同于精确期望值（见 PRD 8.4 首版实现口径）。

import type { Meld } from '../game/types'
import type { Tile, TileType } from '../types'
import { isWinningHand } from '../game/scoring'

// ---------------------------------------------------------------------------
// 1. 机会数基准值（成都册第二章第一节）
// ---------------------------------------------------------------------------

export const OPPORTUNITY_BASELINE = {
  /** 单吊基准机会数 */
  singleWait: 3,
  /** 间张（卡张）听基准机会数 */
  kanchanWait: 4,
  /** 两头听最大机会数 */
  twoSidedMax: 8,
  /** 三面听最大机会数 */
  threeSidedMax: 11,
  /** 机会数 ≥ 24 视为"听牌很容易" */
  largeThreshold: 24,
} as const

// ---------------------------------------------------------------------------
// 2. 强组合（两张牌组合秘籍）
// 27/37/38 效率最高，只用 2 个数连接 1-9 全部数字；28 同属保护清单。
// 来源：理论册第三节《2张牌的组合秘籍》
// ---------------------------------------------------------------------------

export const STRONG_TWO_TILE_COMBOS: ReadonlyArray<readonly [number, number]> = [
  [2, 7],
  [3, 7],
  [2, 8],
  [3, 8],
] as const

/** 判断某个 (a, b) 数字对是否属于强组合（含顺子与隔张两种表达，如 2-7 隔张、3-7 顺搭） */
export function isStrongCombo(a: number, b: number): boolean {
  const low = Math.min(a, b)
  const high = Math.max(a, b)
  return STRONG_TWO_TILE_COMBOS.some(([x, y]) => low === x && high === y)
}

/** 打掉某张牌后，是否破坏了手牌中的强组合（返回被打掉前存在、打掉后消失的组合列表） */
export function brokenStrongCombos(hand: readonly Tile[], discard: Tile): ReadonlyArray<readonly [number, number]> {
  const sameSuit = (tile: Tile) => tile.type === discard.type
  const before = new Set(hand.filter(sameSuit).map(tile => tile.value))
  const discardedIndex = hand.findIndex(tile => tile.type === discard.type && tile.value === discard.value)
  if (discardedIndex < 0)
    return []
  // 来源：理论册第三节“2张牌的组合秘籍”。同值牌有副本时，只移除实际打出的那一张。
  const remainingValues = new Set(hand
    .filter((_, index) => index !== discardedIndex)
    .filter(sameSuit)
    .map(tile => tile.value))
  const broken: Array<readonly [number, number]> = []
  for (const [x, y] of STRONG_TWO_TILE_COMBOS) {
    if (before.has(x) && before.has(y) && !(remainingValues.has(x) && remainingValues.has(y)))
      broken.push([x, y])
  }
  return broken
}

// ---------------------------------------------------------------------------
// 3. 机会数计算（有效进张）
// 机会数 = 能让手牌直接听牌（加入后成胡牌形）的进张剩余张数之和。
// 复用引擎 isWinningHand，保证与规则判定一致。
// ---------------------------------------------------------------------------

export interface OpportunityResult {
  /** 机会数（有效进张剩余张数总和） */
  total: number
  /** 仍有活张的有效进张明细 */
  waits: Array<{ tile: Tile, remaining: number }>
  /** 牌型上可胡的全部叫口，包括公开信息下已经无剩余的死叫 */
  structuralWaits: Array<{ tile: Tile, remaining: number }>
}

function remainingOf(tile: Tile, hand: readonly Tile[], visible: readonly Tile[]): number {
  const seen = hand.filter(t => t.type === tile.type && t.value === tile.value).length
    + visible.filter(t => t.type === tile.type && t.value === tile.value).length
  return Math.max(0, 4 - seen)
}

export interface OpportunityOptions {
  /** 定缺门：定缺花色的牌不可用于胡牌，不计入有效进张 */
  dingque?: TileType | null
  /** 已公开的碰杠副露；用于计算暗手仍需组成的面子数 */
  melds?: readonly Meld[]
}

/**
 * 计算一手待摸牌的机会数。无副露时为 13 张；有副露时按剩余暗手张数计算。
 * @param hand 当前手牌
 * @param visible 已可见的牌（牌河/鸣牌等），用于扣减剩余张数
 * @param options 可选：定缺门等约束
 */
export function countOpportunities(hand: readonly Tile[], visible: readonly Tile[] = [], options: OpportunityOptions = {}): OpportunityResult {
  const waits: OpportunityResult['waits'] = []
  const structuralWaits: OpportunityResult['structuralWaits'] = []
  const meldCount = options.melds?.length ?? 0
  // 来源：理论册第一、二节及成都册第二章第一节。只计算“再摸一张即可成牌”的待摸结构。
  const expectedHandCount = (4 - meldCount) * 3 + 1
  if (meldCount < 0 || meldCount > 4 || hand.length !== expectedHandCount)
    return { total: 0, waits, structuralWaits }
  const types: TileType[] = ['万', '条', '筒']
  for (const type of types) {
    for (let value = 1; value <= 9; value++) {
      const candidate: Tile = { type, value }
      const remaining = remainingOf(candidate, hand, visible)
      const trial = [...hand, candidate]
      // 定缺门进张即使能组成面子也会被 isWinningHand 拒绝（hasDingque 校验）
      if (isWinningHand(trial, { dingque: options.dingque ?? null, melds: options.melds })) {
        const wait = { tile: candidate, remaining }
        structuralWaits.push(wait)
        if (remaining > 0)
          waits.push(wait)
      }
    }
  }
  return { total: waits.reduce((sum, wait) => sum + wait.remaining, 0), waits, structuralWaits }
}

// ---------------------------------------------------------------------------
// 4. 听牌形态分类（评估"听牌快不快、个数多不多"）
// ---------------------------------------------------------------------------

export type WaitShape = 'single' | 'kanchan' | 'twoSided' | 'threeSided' | 'other'

type Wait = OpportunityResult['structuralWaits'][number]

function tileIndex(tile: Tile): number {
  const typeIndex = (['万', '条', '筒'] as const).indexOf(tile.type)
  return typeIndex * 9 + tile.value - 1
}

function tileCounts(tiles: readonly Tile[]): number[] {
  const counts = Array.from({ length: 27 }, () => 0)
  for (const tile of tiles)
    counts[tileIndex(tile)]++
  return counts
}

function canFormMelds(counts: number[], groupsNeeded: number): boolean {
  if (groupsNeeded === 0)
    return counts.every(count => count === 0)
  const first = counts.findIndex(count => count > 0)
  if (first < 0)
    return false

  if (counts[first] >= 3) {
    counts[first] -= 3
    const tripletWorks = canFormMelds(counts, groupsNeeded - 1)
    counts[first] += 3
    if (tripletWorks)
      return true
  }

  const valueIndex = first % 9
  if (valueIndex <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0) {
    counts[first]--
    counts[first + 1]--
    counts[first + 2]--
    const sequenceWorks = canFormMelds(counts, groupsNeeded - 1)
    counts[first]++
    counts[first + 1]++
    counts[first + 2]++
    if (sequenceWorks)
      return true
  }
  return false
}

function canFormMeldsAndPair(counts: number[], groupsNeeded: number): boolean {
  for (let index = 0; index < counts.length; index++) {
    if (counts[index] < 2)
      continue
    counts[index] -= 2
    const works = canFormMelds(counts, groupsNeeded)
    counts[index] += 2
    if (works)
      return true
  }
  return false
}

interface WaitRoles {
  pair: boolean
  sequence: boolean
  middleSequence: boolean
}

function isSevenPairsCompletion(hand: readonly Tile[], candidate: Tile, meldCount: number): boolean {
  if (meldCount !== 0 || hand.length !== 13)
    return false
  const counts = tileCounts([...hand, candidate]).filter(count => count > 0)
  return counts.every(count => count === 2 || count === 4)
    && counts.reduce((sum, count) => sum + count / 2, 0) === 7
}

function waitRoles(hand: readonly Tile[], candidate: Tile, meldCount: number): WaitRoles {
  const groupsNeeded = 4 - meldCount
  const counts = tileCounts(hand)
  const candidateIndex = tileIndex(candidate)
  let pair = isSevenPairsCompletion(hand, candidate, meldCount)
  let sequence = false
  let middleSequence = false

  if (counts[candidateIndex] > 0) {
    counts[candidateIndex]--
    pair ||= canFormMelds(counts, groupsNeeded)
    counts[candidateIndex]++
  }

  for (let start = candidate.value - 2; start <= candidate.value; start++) {
    if (start < 1 || start > 7)
      continue
    const otherValues = [start, start + 1, start + 2].filter(value => value !== candidate.value)
    const otherIndexes = otherValues.map(value => tileIndex({ type: candidate.type, value }))
    if (otherIndexes.some(index => counts[index] === 0))
      continue
    for (const index of otherIndexes)
      counts[index]--
    const works = canFormMeldsAndPair(counts, groupsNeeded - 1)
    for (const index of otherIndexes)
      counts[index]++
    if (works) {
      sequence = true
      middleSequence ||= candidate.value === start + 1
    }
  }
  return { pair, sequence, middleSequence }
}

/**
 * 根据待摸手牌的实际成牌分解识别听牌形态。
 * 来源：成都册第二章第一节。叫口数量只给机会数上限，具体形态必须结合手牌结构。
 * 未提供手牌时仅保守识别明确的多叫口，不根据单个叫牌数字猜测形态。
 */
export function classifyWaitShape(waits: readonly Wait[]): WaitShape
export function classifyWaitShape(hand: readonly Tile[], waits: readonly Wait[], options?: OpportunityOptions): WaitShape
export function classifyWaitShape(
  handOrWaits: readonly Tile[] | readonly Wait[],
  maybeWaits?: readonly Wait[],
  options: OpportunityOptions = {},
): WaitShape {
  const hand = maybeWaits === undefined ? null : handOrWaits as readonly Tile[]
  const waits = (maybeWaits ?? handOrWaits) as readonly Wait[]
  if (waits.length === 0)
    return 'other'

  const sameSuit = waits.every(wait => wait.tile.type === waits[0].tile.type)
  if (hand === null) {
    if (waits.length >= 3 && sameSuit)
      return 'threeSided'
    if (waits.length === 2 && sameSuit && Math.abs(waits[0].tile.value - waits[1].tile.value) === 3)
      return 'twoSided'
    return 'other'
  }

  const meldCount = options.melds?.length ?? 0
  const roles = waits.map(wait => waitRoles(hand, wait.tile, meldCount))
  if (waits.length >= 3)
    return sameSuit && roles.every(role => role.sequence) ? 'threeSided' : 'other'
  if (waits.length === 2) {
    const openEnded = sameSuit
      && Math.abs(waits[0].tile.value - waits[1].tile.value) === 3
      && roles.every(role => role.sequence)
    return openEnded ? 'twoSided' : 'other'
  }
  if (roles[0].pair)
    return 'single'
  if (roles[0].middleSequence)
    return 'kanchan'
  return 'other'
}

/** 机会数质量评级（供复盘"听牌质量"检查项使用） */
export function rateOpportunity(total: number): 'poor' | 'fair' | 'good' | 'excellent' {
  if (total >= OPPORTUNITY_BASELINE.largeThreshold)
    return 'excellent'
  if (total >= OPPORTUNITY_BASELINE.twoSidedMax)
    return 'good'
  if (total >= OPPORTUNITY_BASELINE.kanchanWait)
    return 'fair'
  return 'poor'
}

// ---------------------------------------------------------------------------
// 5. 防守与安全（攻防维度启发式）
// 来源：成都册《实用小技巧》《杠牌打法秘籍》、理论册《术语解释》
// ---------------------------------------------------------------------------

/** 踩线表：1/4/7、2/5/8、3/6/9 */
export const SAFE_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 4, 7],
  [2, 5, 8],
  [3, 6, 9],
] as const

/** 返回某张牌所属的线（147/258/369），用于"踩线"判断 */
export function lineOf(value: number): number {
  return ((value - 1) % 3) + 1
}

/** 是否边张（1 或 9） */
export function isTerminal(value: number): boolean {
  return value === 1 || value === 9
}

/** 跟打优先级：跟上家 > 跟对家 > 跟下家 */
export const FOLLOW_DISCARD_ORDER = ['upper', 'opposite', 'lower'] as const
export type FollowDiscardTarget = typeof FOLLOW_DISCARD_ORDER[number]

export interface DiscardSafetyContext {
  value: number
  isLateGame: boolean
  familiarBy?: Partial<Record<FollowDiscardTarget, boolean>>
  opponentMeldCount?: number
  sameSuitOpponentMeldCount?: number
  dingqueOpponentCount?: number
}

export interface DiscardSafetyAssessment {
  score: number
  danger: number
  followed: FollowDiscardTarget | null
}

/** 是否同一条线（如 4 与 7 同属 1/4/7 线）：踩线判断用 */
export function sameLine(a: number, b: number): boolean {
  return lineOf(a) === lineOf(b)
}

/**
 * 防守出牌安全评估（0-1，越高越安全）。
 * 来源：成都册第二章第三节、第三章“进攻、防守与综合”及“实用小技巧”。
 */
export function assessDiscardSafety(context: DiscardSafetyContext): DiscardSafetyAssessment {
  const followed = FOLLOW_DISCARD_ORDER.find(target => context.familiarBy?.[target]) ?? null
  let score = context.value === 1 || context.value === 4 || context.value === 7
    ? 0.6
    : context.value === 2 || context.value === 5 || context.value === 8
      ? 0.5
      : 0.4

  if (context.isLateGame && isTerminal(context.value))
    score = Math.max(score, 0.8)
  if (followed !== null)
    score = { upper: 1, opposite: 0.95, lower: 0.9 }[followed]

  const meldPressure = Math.min(0.25, (context.opponentMeldCount ?? 0) * 0.025
    + (context.sameSuitOpponentMeldCount ?? 0) * 0.06)
  const dingqueRelief = Math.min(0.24, (context.dingqueOpponentCount ?? 0) * 0.08)
  score = Math.max(0, Math.min(1, score - meldPressure + dingqueRelief))
  return { score, danger: 1 - score, followed }
}

/** 兼容旧调用的基础安全分。来源：成都册“实用小技巧”。 */
export function safetyScore(value: number, isShouZhang: boolean, isLateGame: boolean): number {
  return assessDiscardSafety({
    value,
    isLateGame,
    familiarBy: isShouZhang ? { upper: true } : undefined,
  }).score
}

// ---------------------------------------------------------------------------
// 6. 杠牌原则
// "通常情况下，杠牌不能破坏牌型结构。"（成都册第四节《杠牌打法秘籍》）
// ---------------------------------------------------------------------------

export type GangHandPhase = 'beforeReplacement' | 'afterReplacement'

/**
 * 判断杠后暗手张数是否合法。
 * 来源：成都册第三章“杠牌打法秘籍”。补牌前是待摸结构，补牌后是待打结构。
 */
export function gangBreaksStructure(
  handCountAfterGang: number,
  meldsAfterGang: number,
  phase: GangHandPhase = 'beforeReplacement',
): boolean {
  if (!Number.isInteger(handCountAfterGang) || !Number.isInteger(meldsAfterGang) || meldsAfterGang < 1 || meldsAfterGang > 4)
    return true
  const neededMelds = 4 - meldsAfterGang
  const expectedHandCount = neededMelds * 3 + (phase === 'beforeReplacement' ? 1 : 2)
  return handCountAfterGang !== expectedHandCount
}

export const GANG_OPPORTUNITY_LOSS_THRESHOLD = OPPORTUNITY_BASELINE.kanchanWait

export interface GangStructureOptions extends OpportunityOptions {
  phase?: GangHandPhase
  visible?: readonly Tile[]
  referenceOpportunity?: number
  referenceStructuralWaits?: number
}

export interface GangStructureAssessment {
  preservesStructure: boolean
  countValid: boolean
  breaksReadyState: boolean
  materiallyReducesOpportunity: boolean
  opportunity: OpportunityResult
}

/**
 * 评估杠后是否保留已下叫结构及活张。
 * 来源：成都册“杠牌打法秘籍”；明显损失以第二章第一节的间张 4 张机会数为基准。
 */
export function assessGangStructure(
  handAfterGang: readonly Tile[],
  meldsAfterGang: readonly Meld[],
  options: GangStructureOptions = {},
): GangStructureAssessment {
  const phase = options.phase ?? 'beforeReplacement'
  const countValid = !gangBreaksStructure(handAfterGang.length, meldsAfterGang.length, phase)
  const opportunity = countValid && phase === 'beforeReplacement'
    ? countOpportunities(handAfterGang, options.visible ?? [], {
        dingque: options.dingque,
        melds: meldsAfterGang,
      })
    : { total: 0, waits: [], structuralWaits: [] }
  const hadReadyState = (options.referenceStructuralWaits ?? 0) > 0
  const breaksReadyState = hadReadyState && opportunity.structuralWaits.length === 0
  const materiallyReducesOpportunity = hadReadyState
    && (options.referenceOpportunity ?? 0) - opportunity.total >= GANG_OPPORTUNITY_LOSS_THRESHOLD
  return {
    preservesStructure: countValid && !breaksReadyState && !materiallyReducesOpportunity,
    countValid,
    breaksReadyState,
    materiallyReducesOpportunity,
    opportunity,
  }
}

// ---------------------------------------------------------------------------
// 7. 成都麻将番种速查（第四章《番种秘籍》）
// ---------------------------------------------------------------------------

export interface FanPatternInfo {
  name: string
  fan: number
  note: string
}

export const CHENGDU_FAN_TABLE: ReadonlyArray<FanPatternInfo> = [
  { name: '平胡', fan: 0, note: '以速度为先，尽快下听' },
  { name: '碰碰胡', fan: 1, note: '保留对子，注意碰牌时机' },
  { name: '清一色', fan: 2, note: '花色集中，配合定缺' },
  { name: '七对', fan: 2, note: '不碰不杠，保留对子潜力' },
  { name: '金钩钓（大单吊）', fan: 2, note: '单吊听牌，可结合欺骗战术' },
  { name: '龙七对', fan: 3, note: '七对含一暗杠' },
  { name: '清七对', fan: 4, note: '清一色 + 七对' },
  { name: '双龙七对', fan: 4, note: '七对含两暗杠' },
  { name: '带幺九', fan: 0, note: '保留 1/9 结构' },
  { name: '清对胡', fan: 0, note: '清一色 + 对子胡复合' },
  { name: '将对胡', fan: 0, note: '仅含 2/5/8 的对子胡' },
] as const

// ---------------------------------------------------------------------------
// 8. 复盘启发式规则清单（供复盘引擎参考，可按需调整权重）
// ---------------------------------------------------------------------------

export interface ReviewHeuristic {
  dimension: 'tileEfficiency' | 'attackDefense' | 'meld'
  rule: string
  severity: 'high' | 'medium' | 'low'
  source: string
}

export const REVIEW_HEURISTICS: ReadonlyArray<ReviewHeuristic> = [
  {
    dimension: 'tileEfficiency',
    rule: '拆散 27/28/37/38 强组合应严重惩罚',
    severity: 'high',
    source: '理论册·2张牌组合秘籍',
  },
  {
    dimension: 'tileEfficiency',
    rule: '破坏"已下听"结构应严重惩罚',
    severity: 'high',
    source: '理论册·优先原则',
  },
  {
    dimension: 'tileEfficiency',
    rule: '可形成四人抬轿时放弃留对子应惩罚',
    severity: 'medium',
    source: '理论册·3张牌组合秘籍',
  },
  {
    dimension: 'tileEfficiency',
    rule: '8 张时未打对子挨张成 7 张无听（可成而未成）应检查',
    severity: 'medium',
    source: '成都册·中局打法秘籍',
  },
  {
    dimension: 'attackDefense',
    rule: '打熟不打生；跟打优先级 上家>对家>下家',
    severity: 'high',
    source: '成都册·实用小技巧',
  },
  {
    dimension: 'attackDefense',
    rule: '尾盘打边张比打中张安全',
    severity: 'medium',
    source: '成都册·实用小技巧',
  },
  {
    dimension: 'meld',
    rule: '杠牌不得破坏牌型结构',
    severity: 'high',
    source: '成都册·杠牌打法秘籍',
  },
  {
    dimension: 'meld',
    rule: '碰牌后可评估"放飞鸽"（碰 3 筒放飞 4 筒诱牌）价值',
    severity: 'low',
    source: '成都册·牌型组合秘籍案例',
  },
] as const
