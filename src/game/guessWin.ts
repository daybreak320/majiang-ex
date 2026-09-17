// 叫口推演 · 停听说牌分析
// 每逢有玩家停牌（听牌），基于公开信息（定缺 / 牌河 / 副露 / 自己手牌）做两路推演：
//   路径一「穷举收敛」：枚举该听牌玩家所有可能胡的牌，按公开扣张算出每张的剩余活张与概率。
//   路径二「大胆猜测」：结合成牌规则（把其暗手反推成面子组合）+ 公开信号（副露同色、清缺、碰杠数、行牌顺序），
//                       给出其手牌构成的大胆假设（清一色 / 对对胡 / 七对 / 金钩钓 / 普通平胡）与置信度。
// 说明：单机模拟中引擎持有真实暗手，路径二“反推组合”是直接可行的；实战里暗手未知，仅作强推断参考。

import type { OpportunityResult, WaitShape } from '../knowledge/mahjongTheory'
import type { MeldGroup, Tile, TileType, TingPattern } from '../types'
import type { GameState, PlayerId, PlayerState, TileInstance } from './types'
import { classifyWaitShape, countOpportunities } from '../knowledge/mahjongTheory'
import { analyzeTingPatterns } from '../utils/majiang'
import { MILESTONE_1_RULES } from './rules'
import { identifyFanPatterns } from './scoring'

const EMPTY_OPPORTUNITY: OpportunityResult = { total: 0, waits: [], structuralWaits: [] }

// 与引擎轮转 (from+1)%4 一致：玩家 1 = 下家（右手边）、玩家 3 = 上家（左手边）
const GUESS_POSITIONS: Record<PlayerId, string> = { 0: '你', 1: '下家', 2: '对家', 3: '上家' }

function projectTile(t: TileInstance): Tile {
  return { type: t.type, value: t.value }
}

/** 除目标玩家暗手外的所有已知牌（自己与已胡者的暗手对猜测者可见，对手暗手不可见）。 */
function gatherPublic(state: GameState, targetId: PlayerId): Tile[] {
  const tiles: Tile[] = []
  for (const p of state.players) {
    if (p.id !== targetId && (p.id === 0 || p.hasWon)) {
      tiles.push(...p.hand.map(projectTile))
    }
    tiles.push(
      ...p.discards.map(projectTile),
      ...p.melds.flatMap(meld => meld.tiles).map(projectTile),
    )
  }
  return tiles
}

/** 取某玩家“听牌态的 13 张暗手”与其听牌机会（兼容刚摸 14 张的情况，枚举最优弃牌）。 */
function baseTingHand(state: GameState, playerId: PlayerId): { hand13: Tile[], opportunity: OpportunityResult } {
  const player = state.players[playerId]
  const visible = gatherPublic(state, playerId)
  const expected = (4 - player.melds.length) * 3 + 1
  const hand = player.hand.map(projectTile)
  if (hand.length === expected) {
    return {
      hand13: hand,
      opportunity: countOpportunities(hand, visible, { dingque: player.dingque, melds: player.melds }),
    }
  }
  if (hand.length === expected + 1) {
    const seen = new Set<string>()
    let best: { hand13: Tile[], opportunity: OpportunityResult } = { hand13: [], opportunity: EMPTY_OPPORTUNITY }
    for (const tile of hand) {
      const key = `${tile.type}-${tile.value}`
      if (seen.has(key))
        continue
      seen.add(key)
      const rest = hand.filter(candidate => candidate !== tile)
      const opportunity = countOpportunities(rest, [...visible, tile], {
        dingque: player.dingque,
        melds: player.melds,
      })
      if (opportunity.structuralWaits.length > best.opportunity.structuralWaits.length
        || (opportunity.structuralWaits.length === best.opportunity.structuralWaits.length
          && opportunity.total > best.opportunity.total)) {
        best = { hand13: rest, opportunity }
      }
    }
    return best
  }
  return { hand13: [], opportunity: EMPTY_OPPORTUNITY }
}

export interface GuessWinWait {
  tile: Tile
  remaining: number
  /** 按公开扣张算出的和牌概率（0-1） */
  prob: number
  /** 剩余活张为 0 的死叫 */
  dead: boolean
  /** 该叫口成牌的基础番（成牌规则反推） */
  baseFan: number
}

export interface GuessWinHypothesis {
  kind: 'qingyise' | 'duiduihu' | 'qidui' | 'jingoudiao' | 'pinghu' | 'decompose'
  label: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
  /** 成牌规则反推出的固定面子（不含补的那张叫牌） */
  concealed: Array<{ kind: MeldGroup['kind'], tiles: Tile[] }>
  /** 搭子（缺一张即成型的部分） */
  waitTiles: Tile[]
  /** 该组合下可胡的牌 */
  winsOn: Tile[]
}

export interface GuessWinPlayer {
  playerId: PlayerId
  position: string
  displayName: string
  dingque: TileType | null
  clearedDingque: boolean
  meldCount: number
  waitShape: WaitShape
  unknownTiles: number
  totalOpportunity: number
  waits: GuessWinWait[]
  hypotheses: GuessWinHypothesis[]
  /** 听牌态的暗手（引擎已知；实战里靠信号推断）。拆「看推演」用。 */
  hand13: Tile[]
  /** 已公开副露牌（拆「看推演」时并入暗手，凑成完整 14 张胡牌形）。 */
  meldTiles: Tile[]
}

export interface GuessWinResult {
  active: boolean
  players: GuessWinPlayer[]
  wallTiles: number
}

function kindLabel(kind: MeldGroup['kind']): string {
  return kind === 'sequence' ? '顺子' : kind === 'triplet' ? '刻子' : kind === 'pair' || kind === 'qiduiPair' ? '将' : kind
}

function buildHypotheses(player: PlayerState, hand13: Tile[], waits: Array<{ tile: Tile, remaining: number }>): GuessWinHypothesis[] {
  const winTiles = waits.map(wait => wait.tile)
  // 副露会改变暗手张数，需把副露牌补回成“完整 13 张听牌态”再按成牌规则反推分解。
  const effectiveHand = player.melds.length === 0
    ? hand13
    : [...hand13, ...player.melds.flatMap(meld => meld.tiles).map(projectTile)]
  const patterns = analyzeTingPatterns(effectiveHand, winTiles) // 按固定面子数降序
  const meldTiles = player.melds.flatMap(meld => meld.tiles)
  const tripletMelds = player.melds.filter(meld => meld.kind === 'peng' || meld.kind.includes('Gang')).length
  const dominantType = meldTiles[0]?.type
  const allSameColor = meldTiles.length >= 2
    && dominantType !== undefined
    && dominantType !== player.dingque
    && meldTiles.every(tile => tile.type === dominantType)
  const cleared = player.dingque !== null && player.discards.some(tile => tile.type === player.dingque)

  const fanCount: Record<string, number> = {}
  for (const win of winTiles) {
    const fps = identifyFanPatterns([...hand13, win], { dingque: player.dingque, melds: player.melds })
    for (const fp of fps)
      fanCount[fp.id] = (fanCount[fp.id] ?? 0) + 1
  }

  const toConcealed = (pattern: TingPattern | undefined) =>
    pattern ? pattern.melds.map(m => ({ kind: m.kind, tiles: m.tiles })) : []

  const hyps: GuessWinHypothesis[] = []

  if (allSameColor && dominantType) {
    const group = patterns.find(pattern => pattern.melds.every(m => m.tiles.every(t => t.type === dominantType)))
      ?? patterns[0]
    hyps.push({
      kind: 'qingyise',
      label: `清一色收口（偏${dominantType}）`,
      confidence: cleared ? 'high' : 'medium',
      reason: `副露 ${player.melds.length} 组同色${cleared ? `，且已清定缺${player.dingque}` : '，但定缺尚未完全清出'}，花色高度集中，尾盘该门危险。`,
      concealed: toConcealed(group),
      waitTiles: group?.wait ?? [],
      winsOn: group?.winsOn ?? [],
    })
  }

  if (tripletMelds >= 2) {
    const group = patterns.find(pattern => pattern.melds.filter(m => m.kind === 'triplet').length >= 2)
      ?? patterns[0]
    hyps.push({
      kind: 'duiduihu',
      label: '对对胡 / 碰碰胡倾向',
      confidence: tripletMelds >= 3 ? 'high' : 'medium',
      reason: `已公开 ${tripletMelds} 组刻子或杠，剩余暗手大概率继续收对子或单吊。`,
      concealed: toConcealed(group),
      waitTiles: group?.wait ?? [],
      winsOn: group?.winsOn ?? [],
    })
  }

  if ((fanCount.qiDui ?? 0) > 0 || (fanCount.qingQiDui ?? 0) > 0 || (fanCount.longQiDui ?? 0) > 0 || (fanCount.shuangLongQiDui ?? 0) > 0) {
    const group = patterns.find(pattern => pattern.melds.every(m => m.kind === 'qiduiPair'))
    hyps.push({
      kind: 'qidui',
      label: '七对结构',
      confidence: 'high',
      reason: '成牌规则反推：其暗手按七对拆分成立（不碰不杠、对子潜力足）。',
      concealed: toConcealed(group),
      waitTiles: group?.wait ?? [],
      winsOn: group?.winsOn ?? [],
    })
  }

  if (player.melds.length === 4) {
    hyps.push({
      kind: 'jingoudiao',
      label: '金钩钓（大单吊）',
      confidence: 'high',
      reason: '四副副露已成型，仅留一张单钓；若单钓生张则番值可观。',
      concealed: [],
      waitTiles: [],
      winsOn: winTiles,
    })
  }

  if (hyps.length === 0) {
    const group = patterns[0]
    hyps.push({
      kind: 'pinghu',
      label: '普通平胡',
      confidence: 'low',
      reason: '公开结构无大牌信号；按成牌规则，其暗手最可能拆成如下普通组合收口。',
      concealed: toConcealed(group),
      waitTiles: group?.wait ?? [],
      winsOn: group?.winsOn ?? [],
    })
  }

  // 始终补一条“成牌规则反推的最可能组合”，让大胆猜测有具体手牌构成可看。
  if (!hyps.some(h => h.concealed.length > 0) && patterns.length > 0) {
    const group = patterns[0]
    hyps.push({
      kind: 'decompose',
      label: '成牌规则反推的最可能组合',
      confidence: 'medium',
      reason: '把暗手（引擎已知，实战需靠信号推断）按胡牌形反推，最可能的面子构成：',
      concealed: toConcealed(group),
      waitTiles: group?.wait ?? [],
      winsOn: group?.winsOn ?? [],
    })
  }

  return hyps.slice(0, 4)
}

/** 轻量判定：当前牌局是否有任意玩家处于听牌（停牌）状态。供自动开启面板用，避免每步跑完整分析。 */
export function hasAnyTingPlayer(state: GameState): boolean {
  for (const player of state.players) {
    if (player.hasWon)
      continue
    if (baseTingHand(state, player.id).opportunity.structuralWaits.length > 0)
      return true
  }
  return false
}

/** 主入口：分析当前牌局中所有听牌玩家，产出穷举概率 + 大胆猜测两套数据。 */
export function analyzeGuessWin(state: GameState): GuessWinResult {
  const players: GuessWinPlayer[] = []
  for (const player of state.players) {
    if (player.hasWon)
      continue
    const { hand13, opportunity } = baseTingHand(state, player.id)
    if (opportunity.structuralWaits.length === 0)
      continue

    const visible = gatherPublic(state, player.id)
    const unknownTiles = MILESTONE_1_RULES.tileCount - visible.length
    const waits: GuessWinWait[] = opportunity.structuralWaits
      .map((wait) => {
        const full = [...hand13, wait.tile]
        const patterns = identifyFanPatterns(full, { dingque: player.dingque, melds: player.melds })
        return {
          tile: wait.tile,
          remaining: wait.remaining,
          prob: unknownTiles > 0 ? wait.remaining / unknownTiles : 0,
          dead: wait.remaining === 0,
          baseFan: patterns.reduce((sum, pattern) => sum + pattern.fan, 0),
        }
      })
      .sort((a, b) => b.remaining - a.remaining)

    const waitShape = classifyWaitShape(hand13, opportunity.structuralWaits, {
      dingque: player.dingque,
      melds: player.melds,
    })
    const hypotheses = buildHypotheses(player, hand13, opportunity.structuralWaits)

    players.push({
      playerId: player.id,
      position: GUESS_POSITIONS[player.id],
      displayName: player.displayName?.trim() || GUESS_POSITIONS[player.id],
      dingque: player.dingque,
      clearedDingque: player.dingque !== null && player.discards.some(tile => tile.type === player.dingque),
      meldCount: player.melds.length,
      waitShape,
      unknownTiles,
      totalOpportunity: opportunity.total,
      waits,
      hypotheses,
      hand13,
      meldTiles: player.melds.flatMap(meld => meld.tiles).map(projectTile),
    })
  }
  return { active: players.length > 0, players, wallTiles: state.wall.length }
}

export function describeConcealed(concealed: Array<{ kind: MeldGroup['kind'], tiles: Tile[] }>, waitTiles: Tile[]): string {
  const parts: string[] = []
  for (const group of concealed) {
    const label = group.tiles.map(t => `${t.value}${t.type}`).join('')
    parts.push(group.kind === 'pair' || group.kind === 'qiduiPair' ? `${label}将` : `${label}${kindLabel(group.kind)}`)
  }
  if (waitTiles.length > 0)
    parts.push(`搭子${waitTiles.map(t => `${t.value}${t.type}`).join('')}`)
  return parts.join(' + ') || '—'
}

// ---------------------------------------------------------------------------
// 5. 听牌记忆：跨渲染批次持久记录三家态势
//    背景：手动对局里三家 AI 在快进（skipToResult）模式下被整批算完、只提交最终
//    state，常规模式里听牌窗口也常短到一闪而过；判定逻辑本身零漏判（已用全量对局
//    诊断验证），问题在“渲染只看到最终态”。这里把游戏算过的每一个 state 合并进
//    各玩家的持久态势，面板即可常驻展示“听牌中 / 已胡 / 曾听”。
// ---------------------------------------------------------------------------

export interface TenpaiMemoryEntry {
  /** 本局是否曾进入听牌 */
  everTenpai: boolean
  /** 本局是否已胡牌 */
  won: boolean
  /** 末次被识别为听牌时的完整分析（含叫口与大胆猜测），用于回看 */
  lastDetail: GuessWinPlayer | null
  /** 最近一次追踪时是否正处于听牌 */
  lastTenpai: boolean
}

export type TenpaiMemory = Record<number, TenpaiMemoryEntry>

export function emptyTenpaiMemory(): TenpaiMemory {
  return {}
}

export function positionLabel(id: PlayerId): string {
  return GUESS_POSITIONS[id]
}

/** 把某一时刻的 state 合并进听牌记忆：当前听牌者记最新细表，已胡者保留末次听牌细表。 */
export function trackStateInto(memory: TenpaiMemory, state: GameState): TenpaiMemory {
  const result = analyzeGuessWin(state)
  const tenpaiById = new Map(result.players.map(p => [p.playerId, p]))
  const next: TenpaiMemory = { ...memory }
  for (const player of state.players) {
    const id = player.id
    const isTenpai = tenpaiById.has(id)
    const prev = next[id]
    const detail = isTenpai ? tenpaiById.get(id)! : (prev?.lastDetail ?? null)
    next[id] = {
      everTenpai: (prev?.everTenpai ?? false) || isTenpai,
      won: (prev?.won ?? false) || player.hasWon,
      lastDetail: detail,
      lastTenpai: isTenpai,
    }
  }
  return next
}
