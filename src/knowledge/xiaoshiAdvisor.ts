// 潇老师镜像导师 · 规则判定通道（引擎层，无 UI 依赖）
// 定位：把 xiaoshiRules.ts 的规则库从「文本条目」变成「对一局 GameState 实时判定」的建议。
// 与 game/assistant.ts（朱扬主线教练）平行：朱扬教练按机会数/番型/攻守给主建议，
// 潇老师通道在规则命中时补充「风格镜像」——含原话金句、边界条件与置信度。
// 约定：宁缺毋滥。未命中 = 空数组 = 保持安静，绝不用规则库去抢朱扬教练的主决策权。
// 消费方：训练引擎「导师建议」入口 / 未来 UI 的双视角并列展示。

import type { Tile, TileType } from '../types'
import type { GameState, Meld, PlayerId, PlayerState, TileInstance } from '../game/types'
import { countOpportunities } from './mahjongTheory'
import { getXiaoshiRule } from './xiaoshiRules'
import type { DecisionTheme } from './xiaoshiTypes'

// ---------------------------------------------------------------------------
// 座次：把 playerId 换算为相对座次（以引擎行动流为序）
// ---------------------------------------------------------------------------

export type SeatLabel = '自己' | '下家' | '对家' | '上家'

/**
 * 相对座次。引擎里出牌后按 (a - source + 4) % 4 的距离依次响应（见 engine.ts），
 * 因此 (id - self + 4) % 4 === 1 的那家最先响应 = 口语中的「下家」；
 * 该模型与潇老师「下家打过 7 筒 9 筒」的方位语义自洽。
 */
export function seatLabelOf(self: PlayerId, id: PlayerId): SeatLabel {
  const distance = ((id - self + 4) % 4) as 0 | 1 | 2 | 3
  return distance === 0 ? '自己' : distance === 1 ? '下家' : distance === 2 ? '对家' : '上家'
}

/** 相对距离：0=自己，1=下家，2=对家，3=上家 */
export function relativeDistance(self: PlayerId, id: PlayerId): 0 | 1 | 2 | 3 {
  return ((id - self + 4) % 4) as 0 | 1 | 2 | 3
}

// ---------------------------------------------------------------------------
// 命中建议结构
// ---------------------------------------------------------------------------

/** 一条命中的潇老师镜像建议 */
export interface XiaoshiAdvice {
  /** 规则 id，对应 xiaoshiRules.ts */
  ruleId: string
  ruleName: string
  theme: DecisionTheme | null
  /** 面向的动作窗口：response=碰/杠响应时展示；discard=出牌时展示；any=常驻观察 */
  windowKind: 'response' | 'discard' | 'any'
  /** 一句话镜像观点（可作 UI 标题） */
  headline: string
  /** 结合具体牌面的行动提示 */
  advice: string
  /** 理由原话（口播金句，校正同音错字后保留） */
  quote: string
  /** 规则边界（「如果是 X 我就 Y」类提醒） */
  boundary: string | null
  /** 规则置信度（单期证据 ≤0.85，跨期复现才升 0.9+） */
  confidence: number
  /** 命中的可核验事实（人读，用于展示证据链） */
  evidence: string[]
}

/** 规则执行器的命中产物：元数据（金句/边界/置信度/主题）从规则库统一取 */
type RuleHit = Omit<XiaoshiAdvice, 'ruleId' | 'ruleName' | 'theme' | 'quote' | 'boundary' | 'confidence'>

/** 单条规则的判定上下文 */
interface RuleContext {
  state: GameState
  self: PlayerId
  /** 全桌可见牌（各家牌河 + 副露 + 已胡手牌），用于扣张 */
  visible: TileInstance[]
}

type RuleExecutor = (ctx: RuleContext) => RuleHit | null

// ---------------------------------------------------------------------------
// 公共可见牌
// ---------------------------------------------------------------------------

function publicTiles(state: GameState): TileInstance[] {
  return state.players.flatMap(player => [
    ...player.discards,
    ...player.melds.flatMap(meld => meld.tiles),
    ...(player.hasWon ? player.hand : []),
  ])
}

function sameTile(a: Tile, b: Tile): boolean {
  return a.type === b.type && a.value === b.value
}

function tileLabel(tile: Tile): string {
  return `${tile.value}${tile.type}`
}

// ---------------------------------------------------------------------------
// 执行器 R-RIVER-INFER-v0：对手弃牌邻张反推其手牌结构
// ---------------------------------------------------------------------------

const HIGH_RIVER_PAIR = [7, 9] as const
/** 只在对手「最近这几张」弃牌里找 7+9：过期的信息没有指导价值 */
const RIVER_INFER_RECENT = 8

/**
 * 触发（三条同时满足才算）：
 * ① 某对手最近弃牌中同门出现过 7 与 9（跨 8）；
 * ② 该门不是他的定缺门——定缺门打 7/9 只是打缺，推不出「他没有高张顺子」；
 * ③ 自己手上也有该门的牌——否则这条推断对你眼下的出牌没有意义。
 * 依据 cas_001_d2：下家打过七筒九筒 → 高张区顺子（567/678/789）大概率不在其手。
 * 边界：对手非常规打法（骚操作型）时推断置信度下调（d3）。
 */
function matchRiverInfer(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const myHand = state.players[self].hand
  const suitTypes: TileType[] = ['万', '条', '筒']
  for (let id = 0 as PlayerId; id < 4; id++) {
    if (id === self)
      continue
    const discards = state.players[id].discards
    for (const type of suitTypes) {
      // 自己手上没有这门 → 提示无从落地，静默
      if (!myHand.some(t => t.type === type))
        continue
      // 该门是他的定缺 → 打 7/9 属于例行打缺，不含结构信息
      if (state.players[id].dingque === type || state.players[id].dingque === null)
        continue
      const recent = discards.slice(-RIVER_INFER_RECENT)
      const values = new Set(recent.filter(t => t.type === type).map(t => t.value))
      if (values.has(HIGH_RIVER_PAIR[0]) && values.has(HIGH_RIVER_PAIR[1])) {
        const seat = seatLabelOf(self, id)
        const tile = `${HIGH_RIVER_PAIR[0]}${type}`
        const partner = `${HIGH_RIVER_PAIR[1]}${type}`
        // 全局是否已有该门 7/9 之外的死张佐证（可读信息，供 evidence 引用）
        const lowerTiles = discards.filter(t => t.type === type && t.value < HIGH_RIVER_PAIR[0])
        const extra = lowerTiles.length > 0 ? `；其还弃过 ${lowerTiles.slice(-2).map(tileLabel).join('、')}` : ''
        return {
          windowKind: 'discard',
          headline: `${seat}大概率没有 567/678/789${type} 这类高张顺子`,
          advice: `他弃过 ${tile} 与 ${partner}，该门高张区（7/8/9${type}）在他手里组成顺子的概率很低。` +
            `你想打 ${type} 门高张时，「喂成顺」的担忧可降一档——但这只是降权不是免死，` +
            `仍要按定缺与单张需求常规防守；若对手此局打法非常规，该推断要打折扣。`,
          evidence: [`${seat}弃过 ${tile}、${partner}（同门跨 8）${extra}`, `可核验来源：${seat}的牌河共 ${discards.length} 张`],
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-DROP-CALL-v0：碰牌下叫前先算叫的存活率
// ---------------------------------------------------------------------------

/** 碰后成听但活张 ≤ 此阈值 → 判定为「下叫也是给自己看」的死叫倾向 */
export const DROP_CALL_MAX_LIVE_WAITS = 3
/** 叫口种类 ≥ 此值（如三六九条三面听）→ 视为存活率可接受，不触发 */
export const DROP_CALL_MIN_WAIT_KINDS = 3

/**
 * 触发：响应窗口自己可碰、碰后能立即下叫、但最佳叫口活张很薄。
 * 依据 cas_001_d1：可碰 6 条下 6/9 条叫，但 9 条被上家碰掉（死叫）、6 条中张两侧未断张
 * （易被顺子带走）→ 「暂时不要叫，是为了后面更好的叫，否则有可能下叫也是给自己看」。
 * 边界：若碰后能下 3 种以上且活张充足（如三六九条且三条良好），则照碰。
 */
function matchDropCall(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const window = state.responseWindow
  if (window === null || window.kind !== 'discard' || window.sourcePlayer === self)
    return null
  if (window.choices[self]?.type !== 'peng')
    return null
  const player = state.players[self]
  const target = window.tile
  const pair = player.hand.filter(t => sameTile(t, target))
  if (pair.length < 2)
    return null

  const afterPeng = player.hand.filter(t => t.id !== pair[0].id && t.id !== pair[1].id)
  const meldsAfter = [...player.melds, { kind: 'peng' as const, tiles: [...pair, target], fromPlayer: window.sourcePlayer }]
  const visible = [...ctx.visible, target]

  // 枚举碰后弃牌，寻找能成听的最佳方案（口径与 analyzePeng 一致：碰后弃一张再算待摸机会）
  let best: { live: number, waitKinds: number, waitLabels: string[] } | null = null
  const tried = new Set<string>()
  for (const discard of afterPeng) {
    const key = `${discard.type}-${discard.value}`
    if (tried.has(key))
      continue
    tried.add(key)
    const handAfterDiscard = afterPeng.filter(t => t.id !== discard.id)
    const result = countOpportunities(handAfterDiscard, visible, { dingque: player.dingque, melds: meldsAfter })
    if (result.structuralWaits.length === 0)
      continue
    const live = result.total
    if (best === null || live > best.live) {
      best = {
        live,
        waitKinds: result.structuralWaits.length,
        waitLabels: result.structuralWaits.map(w => `${w.tile.value}${w.tile.type}${w.remaining === 0 ? '(死)' : ''}`),
      }
    }
  }
  if (best === null)
    return null
  // 叫口够宽或活张够多 → 存活率可接受，规则边界内照碰，不干预
  if (best.waitKinds >= DROP_CALL_MIN_WAIT_KINDS || best.live > DROP_CALL_MAX_LIVE_WAITS)
    return null

  const tile = tileLabel(target)
  return {
    windowKind: 'response',
    headline: `碰${tile}能下叫，但这个叫大概率「给自己看」`,
    advice: `碰${tile}后最佳只能下 ${best.waitKinds} 种叫、活张仅 ${best.live} 张` +
      (best.live === 0 ? '（基本是死叫）' : '') +
      `——${best.waitLabels.join('、')}。碰下去会锁死变叫空间；` +
      `如果暗手还有其他进张路线，先别急着碰，等更好的叫再出手。`,
    evidence: [
      `响应窗口：${seatLabelOf(self, window.sourcePlayer)}打出 ${tile}`,
      `碰后最佳叫口：${best.waitKinds} 种 / 活张 ${best.live} 张`,
      `叫口明细：${best.waitLabels.join('、')}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 共享工具：门统计 / 副露结构 / 听牌画像 / 事件时序
// ---------------------------------------------------------------------------

const SUITS: readonly TileType[] = ['万', '条', '筒'] as const

function opponentsOf(self: PlayerId): PlayerId[] {
  return ([0, 1, 2, 3] as PlayerId[]).filter(id => id !== self)
}

function countSuit(tiles: TileInstance[], type: TileType): number {
  return tiles.filter(t => t.type === type).length
}

/** 副露按门统计（每副露计 1，杠同样） */
function meldSuitCounts(melds: Meld[]): Record<TileType, number> {
  const acc: Record<TileType, number> = { 万: 0, 条: 0, 筒: 0 }
  for (const m of melds) {
    const head = m.tiles[0]
    if (head === undefined)
      continue
    acc[head.type] += 1
  }
  return acc
}

/** 副露主导门：副露最集中的那一门（无副露返回 null） */
function dominantMeldSuit(melds: Meld[]): { type: TileType, count: number } | null {
  const acc = meldSuitCounts(melds)
  let best: { type: TileType, count: number } | null = null
  for (const type of SUITS) {
    if (acc[type] > 0 && (best === null || acc[type] > best.count))
      best = { type, count: acc[type] }
  }
  return best
}

/** 全局河牌中某张牌出现过的次数（含副露中的牌，用于判断「深浅」） */
function seenCount(state: GameState, type: TileType, value: number): number {
  let n = 0
  for (const p of state.players) {
    n += p.discards.filter(t => t.type === type && t.value === value).length
    n += p.melds.reduce((c, m) => c + m.tiles.filter(t => t.type === type && t.value === value).length, 0)
  }
  return n
}

/** 一个听牌方案：弃某张后的叫口与存活张数 */
interface WaitPlan {
  /** 需要打出的牌；null = 当前手牌数下已经成听 */
  discard: TileInstance | null
  waits: { label: string, remaining: number }[]
  live: number
}

/**
 * 枚举自己的听牌方案（按存活张数降序）。
 * 口径：手牌 13-3*副露 张时直接判听；14-3*副露 张（刚摸牌）时枚举弃一张。
 */
function waitPlans(player: PlayerState, visible: TileInstance[]): WaitPlan[] {
  const base = 13 - player.melds.length * 3
  const plans: WaitPlan[] = []
  const opts = { dingque: player.dingque, melds: player.melds }
  const evaluate = (hand: TileInstance[], discard: TileInstance | null) => {
    const r = countOpportunities(hand, visible, opts)
    if (r.structuralWaits.length === 0)
      return
    plans.push({
      discard,
      waits: r.structuralWaits.map(w => ({ label: `${w.tile.value}${w.tile.type}`, remaining: w.remaining })),
      live: r.total,
    })
  }
  if (player.hand.length === base) {
    evaluate(player.hand, null)
  }
  else if (player.hand.length === base + 1) {
    const tried = new Set<string>()
    for (const d of player.hand) {
      const key = `${d.type}-${d.value}`
      if (tried.has(key))
        continue
      tried.add(key)
      evaluate(player.hand.filter(t => t.id !== d.id), d)
    }
  }
  plans.sort((a, b) => b.live - a.live)
  return plans
}

/** 事件时序：找「某对手碰了 X，且碰之前打过同门相差 2 点的牌」——反事实推断的原料 */
function findPongBeforeDiscard(
  state: GameState,
  self: PlayerId,
): { playerId: PlayerId, meldTile: TileInstance, earlier: TileInstance } | null {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i]
    if (ev === undefined || ev.type !== 'meld_declared' || ev.playerId === self || ev.meld.kind !== 'peng')
      continue
    const meldTile = ev.meld.tiles[0]
    if (meldTile === undefined)
      continue
    for (let j = i - 1; j >= 0; j--) {
      const prev = state.events[j]
      if (prev === undefined || prev.type !== 'tile_discarded' || prev.playerId !== ev.playerId)
        continue
      if (prev.tile.type === meldTile.type && Math.abs(prev.tile.value - meldTile.value) === 2) {
        return { playerId: ev.playerId, meldTile, earlier: prev.tile }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-REBUILD-HAND-FROM-MELDS-v0：用副露+弃牌时序重建对手手牌
// ---------------------------------------------------------------------------

const REBUILD_MIN_MELDS = 2

/**
 * 触发：某对手 ≥2 副副露且集中在同一门。
 * 依据 cas_012_d4：碰了 3 筒 8 筒两副筒子 → 手上万子居多；再用「若他有 456 万就不会先打 1 万」
 * 这类反事实排除细化结构。
 * 边界：对手打法非常规时降权（规则库已声明）。
 */
function matchRebuildFromMelds(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  for (const id of opponentsOf(self)) {
    const p = state.players[id]
    const dom = dominantMeldSuit(p.melds)
    if (dom === null || dom.count < REBUILD_MIN_MELDS)
      continue
    const seat = seatLabelOf(self, id)
    // 副露主导门之外的两门里，找出他弃得最少的一门 = 其手牌主门
    const others = SUITS.filter(t => t !== dom.type)
    const mainHand = others
      .filter(t => t !== p.dingque)
      .sort((a, b) => countSuit(p.discards, a) - countSuit(p.discards, b))[0]
    if (mainHand === undefined)
      continue
    const early = p.discards.filter(t => t.type === mainHand).slice(0, 2)
    return {
      windowKind: 'any',
      headline: `${seat}两副${dom.type}子副露 → 手牌主门大概率是${mainHand}`,
      advice: `他已碰出 ${dom.count} 副${dom.type}子，${dom.type}子基本被他消耗/定型，` +
        `剩余手牌应集中在${mainHand}门。用反事实排除法细化：若他有某组合，就不会先打出那些早期弃张。` +
        `重建结果只用来估算张数，不要当成精确断言——他打法若非常规，这条要打折扣。`,
      evidence: [
        `${seat}副露：${p.melds.map(m => m.tiles[0]).filter((t): t is TileInstance => t !== undefined).map(tileLabel).join('、')}（${dom.count} 副${dom.type}门）`,
        early.length > 0 ? `其早期弃${mainHand}：${early.map(tileLabel).join('、')} → 可反事实排除相关组合` : `其尚未弃过${mainHand}`,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-READ-BIG-DANDIAO-v0：从副露+弃张逆推对手单钓范围
// ---------------------------------------------------------------------------

const BIG_DANDIAO_MIN_MELDS = 2
const BIG_DANDIAO_MAX_RIVER_IN_SUIT = 1

/**
 * 触发：对手 ≥2 副副露（手牌已薄），且其「非副露门、非定缺门」的那一门几乎没弃过牌。
 * 依据 cas_004_d1：他手上只能收住一张万子，打 8 万 → 无非是 6/7/9 万；再结合他打过 5 万，
 * 锁定 7 万、9 万概率最高。
 * 边界：多家争该门时「只能收住一张」的前提不成立，推断失效。
 */
function matchReadBigDandiao(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  for (const id of opponentsOf(self)) {
    const p = state.players[id]
    if (p.melds.length < BIG_DANDIAO_MIN_MELDS || p.hasWon)
      continue
    const dom = dominantMeldSuit(p.melds)
    // 候选单钓门：既不是其副露主导门，也不是其定缺门
    const candidates = SUITS.filter(t => t !== p.dingque && (dom === null || t !== dom.type))
    if (candidates.length === 0)
      continue
    const suit = candidates
      .slice()
      .sort((a, b) => countSuit(p.discards, a) - countSuit(p.discards, b))[0]
    if (suit === undefined || countSuit(p.discards, suit) > BIG_DANDIAO_MAX_RIVER_IN_SUIT)
      continue
    // 该门有几家在收：≥2 家收 → 前提不成立，静默
    const collectors = state.players.filter(q => q.dingque !== suit).length
    if (collectors >= 3)
      continue
    const seat = seatLabelOf(self, id)
    const handLeft = 13 - p.melds.length * 3
    return {
      windowKind: 'any',
      headline: `${seat}副露 ${p.melds.length} 副且几乎不弃${suit}，单钓大概率在${suit}门`,
      advice: `他手上剩约 ${handLeft} 张、${suit}门一张没怎么打过，说明他在捏${suit}等单钓。` +
        `打${suit}门前先按「他会胡」来评估风险；若能读得更细（如他打过 5${suit}），就把 5${suit} 相关组合排除掉，` +
        `候选范围能再收窄。注意：若多家都在收${suit}，这个推断失效。`,
      evidence: [
        `${seat}副露 ${p.melds.length} 副（${dom === null ? '分散' : `主导${dom.type}门`}），手牌约 ${handLeft} 张`,
        `其${suit}门弃牌仅 ${countSuit(p.discards, suit)} 张 → 明显捏住`,
        `收${suit}门共 ${collectors} 家（含判断前提：越少越接近单钓）`,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-INFO-TWO-COLLECT-v0：两家收牌 + 明确信息 ≈ 单行道
// ---------------------------------------------------------------------------

/** 自己在该门至少要有这么多张，才谈得上「利用单行道进攻」 */
const TWO_COLLECT_MIN_MY_TILES = 3

/** 该门是否是自己手牌里最多的门（最多者并列时取其一即可） */
function isMyStrongestSuit(hand: TileInstance[], suit: TileType): boolean {
  return SUITS.every(s => s === suit || countSuit(hand, s) <= countSuit(hand, suit))
}

/**
 * 触发：某门恰好两家在收（含自己）、自己在该门也有投入，而另一家收牌者给出明确反向信息
 * （副露主导在别的门 / 已明显在弃该门）→ 实际只剩自己在收 ≈ 单行道。
 * 依据 cas_004_d4：两家收牌时若另一方信息明确，机会接近单行道。
 */
function matchInfoTwoCollect(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  if (me.dingque === null)
    return null
  for (const suit of SUITS) {
    if (me.dingque === suit)
      continue
    // 「可大胆进攻某门」只有在该门正是自己的主攻门时才有意义
    if (countSuit(me.hand, suit) < TWO_COLLECT_MIN_MY_TILES || !isMyStrongestSuit(me.hand, suit))
      continue
    const collectors = state.players.filter(q => q.dingque !== suit)
    if (collectors.length !== 2)
      continue
    const other = collectors.find(q => q.id !== self)
    if (other === undefined)
      continue
    const dom = dominantMeldSuit(other.melds)
    const dumping = countSuit(other.discards, suit) >= 2
    const meldedElsewhere = dom !== null && dom.type !== suit
    if (!dumping && !meldedElsewhere)
      continue
    const seat = seatLabelOf(self, other.id)
    const reason = dumping ? `他已弃 ${countSuit(other.discards, suit)} 张${suit}` : `他副露主导在${dom === null ? '' : dom.type}门`
    return {
      windowKind: 'any',
      headline: `${suit}门实际只剩你在收 ≈ 单行道`,
      advice: `原本两家收${suit}，但${seat}给出明确反向信息（${reason}），等于把${suit}门让给你了。` +
        `这种时候可以大胆在${suit}门进攻/做牌，不必按「两家争门」的保守节奏打。`,
      evidence: [
        `收${suit}门：自己 + ${seat}（共 2 家）`,
        reason,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-DEPTH-JUDGE-v0：深张/浅张判断哪张先出
// ---------------------------------------------------------------------------

/**
 * 触发：自己已成听，且同门有 ≥2 个候选胡张，其中有的已在河里露面、有的一张未现。
 * 依据 cas_005_d3：一四筒都是深张，一筒很深，反而四筒有可能会出来。
 * 结论：露过面的=浅张（更容易再被打出）；一张未现的=深张（被捏住，不会先出）。
 */
function matchDepthJudge(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const plans = waitPlans(state.players[self], ctx.visible)
  const best = plans[0]
  if (best === undefined || best.waits.length < 2)
    return null
  for (const suit of SUITS) {
    const inSuit = best.waits.filter(w => w.label.endsWith(suit))
    if (inSuit.length < 2)
      continue
    const ranked = inSuit
      .map(w => ({ ...w, value: Number(w.label.charAt(0)), seen: seenCount(state, suit, Number(w.label.charAt(0))) }))
      .sort((a, b) => b.seen - a.seen)
    const shallow = ranked[0]
    const deep = ranked[ranked.length - 1]
    if (shallow === undefined || deep === undefined || shallow.seen === deep.seen)
      continue
    return {
      windowKind: 'discard',
      headline: `同是${suit}门叫口：${shallow.label}比${deep.label}浅，先出的是${shallow.label}`,
      advice: `按牌河深浅判断：${shallow.label} 已经现了 ${shallow.seen} 张（浅张，别人手里大概率留不住），` +
        `${deep.label} 只现了 ${deep.seen} 张（深张，明显被捏住）。` +
        `所以等${suit}门出张时，先等到的会是${shallow.label}——保留/进攻方向据此调整。对手打法非常规时该判断要降权。`,
      evidence: ranked.map(r => `${r.label}：河里已现 ${r.seen} 张，剩 ${r.remaining} 张`).slice(0, 4),
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-NOREACTION-INFO-v0：对手「无反应」也是信息
// ---------------------------------------------------------------------------

const NOREACTION_MIN_HIDDEN_HIGH = 3 // 7/8/9 全部未现才算「被捏成结构」，缺一张都不够硬
/** 对手至少要打出这么多张，其「某门不弃」才算信息；开局大家都不弃，那是伪信号 */
const NOREACTION_MIN_DISCARDS = 5

/**
 * 触发：某对手已打出若干张（排除开局伪信号），在收某门（定缺不是该门），
 * 却几乎不弃该门，且该门高张（7/8/9）多数未现。
 * 依据 cas_006_d4：打了七条、上家打了八条、对家都没反应 → 高张条子已成两副顺子。
 * 含义：该门高张在他手里已成结构，别指望他会把高张打出来，也别指望自己去上高张。
 */
function matchNoreactionInfo(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  for (const id of opponentsOf(self)) {
    const p = state.players[id]
    if (p.dingque === null || p.hasWon)
      continue
    if (p.discards.length < NOREACTION_MIN_DISCARDS)
      continue
    for (const suit of SUITS) {
      if (p.dingque === suit)
        continue
      // 必须一张没打过才算「捏住」；打过一张以上就说明他没在囤这门
      if (countSuit(p.discards, suit) > 0)
        continue
      const hidden = [7, 8, 9].filter(v => seenCount(state, suit, v) === 0)
      if (hidden.length < NOREACTION_MIN_HIDDEN_HIGH)
        continue
      const seat = seatLabelOf(self, id)
      return {
        windowKind: 'any',
        headline: `${suit}门高张 ${hidden.map(v => `${v}${suit}`).join('、')} 一张未现 → ${seat}那手多半已成结构`,
        advice: `${seat}不缺${suit}却几乎不打${suit}，而且${suit}门高张一张都没出来过——` +
          `说明这些高张大概率已被他（或别家）捏成了顺子/对子结构。结论有两个：` +
          `① 你想上${suit}门高张基本没戏；② 你打${suit}门高张的风险比想象中高。`,
        evidence: [
          `${seat}定缺${p.dingque}，${suit}门仅弃 ${countSuit(p.discards, suit)} 张`,
          `${suit}门未现高张：${hidden.map(v => `${v}${suit}`).join('、')}`,
        ],
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-ENUM-PROB-CHOICE-v0：读不准就枚举情形算张数
// ---------------------------------------------------------------------------

const ENUM_MAX_LIVE_GAP = 1

/**
 * 触发：存在 ≥2 个可选听牌方案，且存活张数几乎相同（差 ≤1）→ 属于「读不准」的情形。
 * 依据 cas_007_d3：无法算出下家准确手牌，只能用概率做最大可能性的选择。
 */
function matchEnumProbChoice(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const plans = waitPlans(state.players[self], ctx.visible)
  if (plans.length < 2)
    return null
  const top = plans[0]
  const second = plans[1]
  if (top === undefined || second === undefined || top.live <= 0)
    return null
  if (top.live - second.live > ENUM_MAX_LIVE_GAP)
    return null
  const describe = (p: WaitPlan) =>
    `${p.discard === null ? '不打' : `打${tileLabel(p.discard)}`} → ${p.waits.map(w => w.label).join('/')}（活 ${p.live} 张）`
  return {
    windowKind: 'discard',
    headline: '两条路线存活张数几乎一样 → 别纠结读牌，按概率选',
    advice: `现在精确读不出谁手里有什么，两条路线的存活张数又咬得很紧（${top.live} vs ${second.live}）。` +
      `这种局面就别再靠「我觉得他像是在做 X」来选了——枚举对手可能的组合、逐情形数剩余张数，` +
      `加总后选期望最大的那条。时间紧时直接用存活张数估算即可。`,
    evidence: [describe(top), describe(second), `牌墙剩 ${state.wall.length} 张`],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-FUTURE-WAIT-DEAD-v0：未来的叫也要先算存活
// ---------------------------------------------------------------------------

/**
 * 触发：存在「弃某张即成听」的诱人路线，但该叫口的关键胡张已经绝张 → 判为死叫路线。
 * 依据 cas_009_d2：即使后面摸到三六条，胡一四条、一四七条都是死叫，因为四条已经被上家顺子吃掉。
 */
function matchFutureWaitDead(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const plans = waitPlans(state.players[self], ctx.visible)
  if (plans.length === 0)
    return null
  const dead = plans.filter(p => p.waits.every(w => w.remaining === 0))
  const alive = plans.filter(p => p.waits.some(w => w.remaining > 0))
  if (dead.length === 0 || alive.length === 0)
    return null
  const worst = dead[0]
  if (worst === undefined)
    return null
  const deadLabels = [...new Set(dead.flatMap(p => p.waits.map(w => w.label)))]
  return {
    windowKind: 'discard',
    headline: '别被「以后能下叫」骗了：那条路线的叫已经是死叫',
    advice: `现在看着可以先忍一手、以后再下叫，但那条路线未来的叫口（${deadLabels.join('、')}）关键张已经没了，` +
      `等到的概率接近零。做路线选择时要把「未来的叫」也算一遍存活，不能只算眼前。`,
    evidence: [
      `死叫路线：${dead.slice(0, 2).map(p => `打${p.discard === null ? '（当前）' : tileLabel(p.discard)} → ${p.waits.map(w => w.label).join('/')}（剩 0）`).join('；')}`,
      `仍有活路的路线 ${alive.length} 条，最佳活 ${alive[0]?.live ?? 0} 张`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-INFER-BEFORE-PONG-v0：看他「碰之前打过什么」
// ---------------------------------------------------------------------------

/**
 * 触发：某对手碰过某张，且碰之前打过同门相差 2 点的牌。
 * 依据 cas_010_d4：上家碰 4 万之前打过 2 万 → 若他有 123 万，完全没必要打 2 万 → 排除该组合。
 * 用途：判断某张是否还在墙里（对估算剩余张数与点炮风险都有用）。
 */
function matchInferBeforePong(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const found = findPongBeforeDiscard(state, self)
  if (found === null)
    return null
  const { playerId, meldTile, earlier } = found
  const lo = Math.min(meldTile.value, earlier.value)
  const hi = Math.max(meldTile.value, earlier.value)
  const mid = lo + 1
  const seat = seatLabelOf(self, playerId)
  const type = meldTile.type
  return {
    windowKind: 'any',
    headline: `${seat}碰${tileLabel(meldTile)}前打过${tileLabel(earlier)} → 可排除他持有 ${lo}${mid}${hi}${type} 组合`,
    advice: `他用反事实推理读牌：如果${seat}手上真有 ${lo}${mid}${hi}${type} 这个顺子，他就没必要先打${tileLabel(earlier)}。` +
      `所以他大概率没有这个组合，${mid}${type} 相关张仍在墙里/别处的可能性更高——` +
      `你在估算${type}门剩余张数时可以据此修正。注意：这套推理完全依赖对手打法合理，遇到骚操作要降权。`,
    evidence: [
      `事件时序：${seat}先打出${tileLabel(earlier)}，之后才碰${tileLabel(meldTile)}`,
      `排除组合：${lo}${type} ${mid}${type} ${hi}${type}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-ESCAPE-AVOID-BIG-v0：躲大牌优先于做大牌
// ---------------------------------------------------------------------------

const BIG_HAND_MIN_MELDS = 2

/**
 * 触发：某对手 ≥2 副副露集中在同一门（做大牌/清一色迹象）。
 * 依据 cas_007_d1：学会躲大牌比做大牌更重要——你每做一个大牌，外面三家也各会做一个。
 */
function matchEscapeAvoidBig(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  for (const id of opponentsOf(self)) {
    const p = state.players[id]
    if (p.hasWon)
      continue
    const dom = dominantMeldSuit(p.melds)
    if (dom === null || dom.count < BIG_HAND_MIN_MELDS)
      continue
    const seat = seatLabelOf(self, id)
    return {
      windowKind: 'any',
      headline: `${seat}已在${dom.type}门碰出 ${dom.count} 副 → 目标切换为「躲」`,
      advice: `识别到大牌信号，就把这一局的目标从「做大自己的牌」改成「防御逃跑」：` +
        `优先下叫、优先躲，分数恰到好处地贪。躲大牌优先于做大牌——` +
        `平均下来你每做一个大牌，外面三家也各会做一个大牌。`,
      evidence: [
        `${seat}副露 ${dom.count} 副集中在${dom.type}门`,
        `${seat}弃牌中另外两门共 ${countSuit(p.discards, SUITS[0]!) + countSuit(p.discards, SUITS[1]!) + countSuit(p.discards, SUITS[2]!) - countSuit(p.discards, dom.type)} 张 → 明显在收单一门`,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-ESCAPE-SWITCH-SUIT-v0：对手做清一色 → 反向利用缺章
// ---------------------------------------------------------------------------

const QING_MIN_MELDS = 2
const QING_MAX_SUIT_RIVER = 1

/**
 * 触发：某对手副露 ≥2 副全在同一门，且自己几乎不弃该门 → 基本确认清一色。
 * 依据 cas_007_d2：对家做清一色、万子都不要 → 原本的缺张弱势反转成两家不要万。
 */
function matchEscapeSwitchSuit(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  for (const id of opponentsOf(self)) {
    const p = state.players[id]
    if (p.hasWon || p.dingque === null)
      continue
    const dom = dominantMeldSuit(p.melds)
    if (dom === null || dom.count < QING_MIN_MELDS)
      continue
    if (countSuit(p.discards, dom.type) > QING_MAX_SUIT_RIVER)
      continue
    // 他不要的门 = 除其清一色门之外的两门；挑自己也收得住、且他也不要的那门
    const avoid = SUITS.filter(t => t !== dom.type)
    const target = avoid.find(t => t !== me.dingque) ?? avoid[0]
    if (target === undefined)
      continue
    const seat = seatLabelOf(self, id)
    return {
      windowKind: 'any',
      headline: `${seat}在做${dom.type}清一色 → 把叫换到${target}门，弱势反转`,
      advice: `${seat}收${dom.type}、弃另外两门，等于把${target}门让出来了——` +
        `原本你在这门的缺章弱势，反而变成了「两家不要${target}」的优势。` +
        `换叫前再确认一下：另一家是不是也在收${target}。`,
      evidence: [
        `${seat}副露 ${dom.count} 副全在${dom.type}门，${dom.type}门仅弃 ${countSuit(p.discards, dom.type)} 张`,
        `其不要的门：${avoid.join('、')}；建议方向：${target}`,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-SET-BOTTOM-LINE-v0：中前期定好走/放底线
// ---------------------------------------------------------------------------

const BOTTOM_LINE_WALL_NOT_LATE = 16
const BOTTOM_LINE_LIVE_TO_PASS = 4

/**
 * 触发：别人打出你能胡的牌（响应窗口可胡），且局面并非极端紧迫。
 * 依据 cas_008_d1/cas_008_d3：提前想好底线和原则然后坚定执行——九筒点炮就胡，六筒看情况。
 * 判定：牌墙尚多 + 自己其他叫口存活张充足 → 可以放一手；否则点炮就胡。
 */
function matchSetBottomLine(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const window = state.responseWindow
  if (window === null || window.kind !== 'discard')
    return null
  const choice = window.choices[self]
  if (choice?.type !== 'hu')
    return null
  const value = choice.value
  const plans = waitPlans(state.players[self], ctx.visible)
  const bestLive = plans[0]?.live ?? 0
  const wallLeft = state.wall.length
  const canPass = wallLeft > BOTTOM_LINE_WALL_NOT_LATE && bestLive >= BOTTOM_LINE_LIVE_TO_PASS
  const tile = tileLabel(window.tile)
  const seat = seatLabelOf(self, window.sourcePlayer)
  return {
    windowKind: 'response',
    headline: canPass ? `${seat}打出${tile}（${value} 分）：按底线可以放一手` : `${seat}打出${tile}（${value} 分）：按底线应该胡`,
    advice: canPass
      ? `牌墙还有 ${wallLeft} 张、你换条路线的存活张有 ${bestLive} 张，属于可以「放一手」的局面——` +
        `前提是你在中前期就想好了底线，而不是临场纠结。想放就把底线记牢，后面同样的牌一律执行。`
      : `牌墙只剩 ${wallLeft} 张、你能等的存活张只有 ${bestLive} 张，这种局面就别想着放一手了，点炮就走。` +
        `（若对手有满牌/杠上花的紧迫威胁，更应直接升级为「点炮就走」。）`,
    evidence: [
      `响应窗口：${seat}打出 ${tile}，胡 ${value} 分`,
      `牌墙剩 ${wallLeft} 张；换个路线存活 ${bestLive} 张`,
      `判据：牌墙 > ${BOTTOM_LINE_WALL_NOT_LATE} 且存活 ≥ ${BOTTOM_LINE_LIVE_TO_PASS} → 可放`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-EARLY-SAFE-DISCARD-v0：已被碰过的张，早打早安全
// ---------------------------------------------------------------------------

/**
 * 触发：手上某张已被他家碰/杠过，且它不在自己最佳叫口里、手上也不是对子 → 早打。
 * 依据 cas_010_d3：上家已经碰过 4 万，早打早安全；4 万对下叫没帮助，但 8 万留下有可能摸成一对。
 */
function matchEarlySafeDiscard(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const plans = waitPlans(me, ctx.visible)
  const waitLabels = new Set((plans[0]?.waits ?? []).map(w => w.label))
  for (const id of opponentsOf(self)) {
    for (const meld of state.players[id].melds) {
      const head = meld.tiles[0]
      if (head === undefined)
        continue
      const mine = me.hand.filter(t => sameTile(t, head))
      if (mine.length === 0 || mine.length >= 2)
        continue
      if (waitLabels.has(tileLabel(head)))
        continue
      const seat = seatLabelOf(self, id)
      return {
        windowKind: 'discard',
        headline: `${tileLabel(head)}已被${seat}${meld.kind === 'peng' ? '碰' : '杠'}过，早打早安全`,
        advice: `${tileLabel(head)}已经被${seat}碰/杠出来，对你下叫也没帮助，留着只是风险。` +
          `原则：已被碰过的张，越早打越安全；反过来，还有潜在价值（能摸成对、能配合碰出）的张才值得留。`,
        evidence: [
          `${seat}的副露中含 ${tileLabel(head)}（${meld.kind}）`,
          `你手上仅 ${mine.length} 张，且不在当前最佳叫口（${[...waitLabels].join('/') || '无'}）里`,
        ],
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 规则执行器注册表（新归纳规则需「可判定化」后在此登记，宁缺毋滥）
// ---------------------------------------------------------------------------

const RULE_EXECUTORS: ReadonlyArray<{ ruleId: string, run: RuleExecutor }> = [
  { ruleId: 'R-RIVER-INFER-v0', run: matchRiverInfer },
  { ruleId: 'R-DROP-CALL-v0', run: matchDropCall },
  // 形势与信息（I 簇）：读牌类
  { ruleId: 'R-REBUILD-HAND-FROM-MELDS-v0', run: matchRebuildFromMelds },
  { ruleId: 'R-READ-BIG-DANDIAO-v0', run: matchReadBigDandiao },
  { ruleId: 'R-INFO-TWO-COLLECT-v0', run: matchInfoTwoCollect },
  { ruleId: 'R-DEPTH-JUDGE-v0', run: matchDepthJudge },
  { ruleId: 'R-NOREACTION-INFO-v0', run: matchNoreactionInfo },
  { ruleId: 'R-ENUM-PROB-CHOICE-v0', run: matchEnumProbChoice },
  { ruleId: 'R-FUTURE-WAIT-DEAD-v0', run: matchFutureWaitDead },
  { ruleId: 'R-INFER-BEFORE-PONG-v0', run: matchInferBeforePong },
  // 防守与逃跑（D 簇）
  { ruleId: 'R-ESCAPE-AVOID-BIG-v0', run: matchEscapeAvoidBig },
  { ruleId: 'R-ESCAPE-SWITCH-SUIT-v0', run: matchEscapeSwitchSuit },
  { ruleId: 'R-SET-BOTTOM-LINE-v0', run: matchSetBottomLine },
  { ruleId: 'R-EARLY-SAFE-DISCARD-v0', run: matchEarlySafeDiscard },
]

/**
 * 抑制表：key 规则在同局中被 value 中任一规则命中时丢弃。
 * 用途：同一信号（如「对手副露集中的大牌」）会同时触发通用告警与具体动作，
 * 只保留更具体的那条，避免镜像导师刷屏。
 */
const SUPPRESSED_BY: Readonly<Record<string, readonly string[]>> = {
  'R-ESCAPE-AVOID-BIG-v0': ['R-ESCAPE-SWITCH-SUIT-v0'],
  'R-REBUILD-HAND-FROM-MELDS-v0': ['R-READ-BIG-DANDIAO-v0'],
}

/**
 * 一次最多返回的「决策类」建议（碰/胡/出牌这类要你立刻做动作的）。
 * 宁缺毋滥：镜像导师不抢朱扬教练的主决策权。
 */
export const MAX_DECISION_ADVICE = 3

/**
 * 一次最多返回的「观察类」建议（读牌信息、形势判断，属于背景板）。
 * 限得更死：这类提示常驻但不该刷屏，UI 上建议折叠展示。
 */
export const MAX_OBSERVE_ADVICE = 1

export interface AdviceOptions {
  /** 决策类上限，默认 MAX_DECISION_ADVICE */
  maxDecision?: number
  /** 观察类上限，默认 MAX_OBSERVE_ADVICE */
  maxObserve?: number
}

/**
 * 主入口：对一局公开可见状态，返回命中的潇老师镜像建议。
 * - 未命中返回空数组（保持安静，不干预朱扬教练的主建议）
 * - 决策类（response/discard）与观察类（any）分开限流，各自按置信度降序截断
 */
export function buildXiaoshiAdvice(
  state: GameState,
  self: PlayerId = 0,
  options: AdviceOptions = {},
): XiaoshiAdvice[] {
  const ctx: RuleContext = { state, self, visible: publicTiles(state) }
  const hits: XiaoshiAdvice[] = []
  for (const { ruleId, run } of RULE_EXECUTORS) {
    const rule = getXiaoshiRule(ruleId)
    if (rule === undefined)
      continue
    const hit = run(ctx)
    if (hit === null)
      continue
    hits.push({
      ruleId,
      ruleName: rule.name,
      theme: rule.theme ?? null,
      quote: rule.rationale,
      boundary: rule.boundary ?? null,
      confidence: rule.confidence,
      ...hit,
    })
  }
  const hitIds = new Set(hits.map(h => h.ruleId))
  const kept = hits.filter(h => !(SUPPRESSED_BY[h.ruleId] ?? []).some(by => hitIds.has(by)))
  kept.sort((a, b) => b.confidence - a.confidence)
  const maxDecision = options.maxDecision ?? MAX_DECISION_ADVICE
  const maxObserve = options.maxObserve ?? MAX_OBSERVE_ADVICE
  const decision = kept.filter(h => h.windowKind !== 'any').slice(0, maxDecision)
  const observe = kept.filter(h => h.windowKind === 'any').slice(0, maxObserve)
  return [...decision, ...observe]
}
