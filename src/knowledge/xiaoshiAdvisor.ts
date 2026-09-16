// 破晓哥镜像导师 · 规则判定通道（引擎层，无 UI 依赖）
// 定位：把 xiaoshiRules.ts 的规则库从「文本条目」变成「对一局 GameState 实时判定」的建议。
// 与 game/assistant.ts（破晓哥主线教练）平行：破晓哥教练按机会数/番型/攻守给主建议，
// 破晓哥通道在规则命中时补充「风格镜像」——含原话金句、边界条件与置信度。
// 约定：宁缺毋滥。未命中 = 空数组 = 保持安静，绝不用规则库去抢破晓哥教练的主决策权。
// 消费方：训练引擎「导师建议」入口 / 未来 UI 的双视角并列展示。

import type { Tile, TileType } from '../types'
import type { GameState, Meld, PlayerId, PlayerState, TileInstance } from '../game/types'
import { countOpportunities } from './mahjongTheory'
import { getXiaoshiRule } from './xiaoshiRules'
import type { DecisionTheme, XiaoshiRule } from './xiaoshiTypes'

// ---------------------------------------------------------------------------
// 座次：把 playerId 换算为相对座次（以引擎行动流为序）
// ---------------------------------------------------------------------------

export type SeatLabel = '自己' | '下家' | '对家' | '上家'

/**
 * 相对座次。引擎里出牌后按 (a - source + 4) % 4 的距离依次响应（见 engine.ts），
 * 因此 (id - self + 4) % 4 === 1 的那家最先响应 = 口语中的「下家」；
 * 该模型与破晓哥「下家打过 7 筒 9 筒」的方位语义自洽。
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

/** 一条命中的破晓哥镜像建议 */
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
  /** 金句与当前局花色不一致时的桥接说明（如案例举条子、当前局是万子）；为 null 不展示 */
  quoteBridge?: string | null
}

/** 规则执行器的命中产物：元数据（金句/边界/置信度/主题）从规则库统一取 */
type RuleHit = Omit<XiaoshiAdvice, 'ruleId' | 'ruleName' | 'theme' | 'quote' | 'boundary' | 'confidence'> & {
  /** 当前局主门花色（由执行器从叫口推导），供 buildXiaoshiAdvice 生成花色桥接；不进 UI 结构 */
  mainSuit?: TileType | null
}

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
// 共享小工具（多条规则复用）
// ---------------------------------------------------------------------------

/** 收某门的家数（还没定缺的早期阶段视为「收」） */
function collectorCount(state: GameState, suit: TileType): number {
  return state.players.filter(p => p.dingque !== suit).length
}

/** 手牌里的对子 */
function pairsOf(hand: TileInstance[]): { tile: TileInstance, count: number }[] {
  const buckets = new Map<string, TileInstance[]>()
  for (const t of hand) {
    const key = `${t.type}-${t.value}`
    const arr = buckets.get(key) ?? []
    arr.push(t)
    buckets.set(key, arr)
  }
  return [...buckets.values()].filter(g => g.length >= 2).map(g => ({ tile: g[0]!, count: g.length }))
}

/** 孤张：同门 ±2 内没有伙伴、且自己也不成对 */

/**
 * 孤张判定。若该张在手上有对子/坎子，或同门附近还有 ±2 内的牌，就不算孤张。
 */
function isolatedTiles(hand: TileInstance[]): TileInstance[] {
  const counts = new Map<string, number>()
  for (const t of hand) {
    const key = `${t.type}-${t.value}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return hand.filter(t => {
    if ((counts.get(`${t.type}-${t.value}`) ?? 0) >= 2)
      return false
    return !hand.some(o => o.id !== t.id && o.type === t.type && Math.abs(o.value - t.value) <= 2)
  })
}

/** 按类型+点数去重取代表张 */
function uniqueTiles(tiles: TileInstance[]): TileInstance[] {
  const seen = new Set<string>()
  return tiles.filter(t => {
    const key = `${t.type}-${t.value}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

/** 最近 n 个事件里是否有「自己刚副露」——用于限定「碰/杠后弃孤张」类规则 */
function iJustMelded(state: GameState, self: PlayerId, within: number): boolean {
  const start = Math.max(0, state.events.length - within)
  for (let i = state.events.length - 1; i >= start; i--) {
    const ev = state.events[i]
    if (ev !== undefined && ev.type === 'meld_declared' && ev.playerId === self)
      return true
  }
  return false
}

/** 最近 n 个事件里自己是否「放过一手胡」——期望收益类规则的触发源 */
function iJustPassedWin(state: GameState, self: PlayerId, within: number): boolean {
  const start = Math.max(0, state.events.length - within)
  for (let i = state.events.length - 1; i >= start; i--) {
    const ev = state.events[i]
    if (ev !== undefined && ev.type === 'passed_win_set' && ev.playerId === self && ev.value !== null)
      return true
  }
  return false
}

/** 已经在做大牌的对手（≥2 副同门副露 / 或 ≥3 副副露），返回最强威胁者 */
function bigHandThreat(state: GameState, self: PlayerId): PlayerId | null {
  let best: PlayerId | null = null
  let bestCount = 0
  for (const id of opponentsOf(self)) {
    const p = state.players[id]
    if (p.hasWon)
      continue
    const dom = dominantMeldSuit(p.melds)
    const score = Math.max(dom?.count ?? 0, p.melds.length >= 3 ? 2 : 0)
    if (score >= 2 && score > bestCount) {
      best = id
      bestCount = score
    }
  }
  return best
}

/** 自己当前的胡：响应窗口里的 hu 选择 */
function myHuChoice(state: GameState, self: PlayerId): { value: number, sourcePlayer: PlayerId, tile: TileInstance } | null {
  const window = state.responseWindow
  if (window === null || window.kind !== 'discard')
    return null
  const choice = window.choices[self]
  if (choice?.type !== 'hu')
    return null
  return { value: choice.value, sourcePlayer: window.sourcePlayer, tile: window.tile }
}

// ---------------------------------------------------------------------------
// 执行器 R-THREAT-ESCAPE-v0：识别到大牌威胁 → 点炮就走
// ---------------------------------------------------------------------------

/** 自摸收益相对点炮收益的倍数（川麻自摸普遍翻倍，够不成悬殊就不改打法） */
const THREAT_SELF_DRAW_EDGE = 2

/**
 * 触发：别人点炮可胡 + 已识别出某对手大牌成势（≥2 副同门副露 / ≥3 副副露）。
 * 依据 cas_002_d2：该怂就怂，不然挨个满的。
 * 边界（规则库）：无满牌威胁时保留放一手打法——所以触发前必须先有证据。
 */
function matchThreatEscape(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const hu = myHuChoice(state, self)
  if (hu === null)
    return null
  const threat = bigHandThreat(state, self)
  if (threat === null)
    return null
  const tp = state.players[threat]
  const dom = dominantMeldSuit(tp.melds)
  const seat = seatLabelOf(self, threat)
  const target = seatLabelOf(self, hu.sourcePlayer)
  return {
    windowKind: 'response',
    headline: `${seat}大牌已成势 → ${target}打出${tileLabel(hu.tile)}点炮就胡`,
    advice: `先把局势说清楚：${seat}已经${dom === null ? `摆出 ${tp.melds.length} 副副露` : `在${dom.type}门碰出 ${dom.count} 副`}，` +
      `说明他不是在做小胡，是在走大牌路线。这个时候你等着自摸是${state.wall.length}分之一的赌博，` +
      `而点炮一放就可能挨满。${target}打出${tileLabel(hu.tile)}（${hu.value} 分）已经是可兑现的收益，` +
      `直接胡掉——该怂就怂。自摸收益再高（顶多差 ${THREAT_SELF_DRAW_EDGE} 倍），也抵不过一次被满的概率。`,
    evidence: [
      `威胁源：${seat}${dom === null ? `副露 ${tp.melds.length} 副` : `${dom.type}门副露 ${dom.count} 副`}`,
      `当前选择：${target}打出${tileLabel(hu.tile)}，可胡 ${hu.value} 分`,
      `牌墙剩 ${state.wall.length} 张 → 自摸机会有限`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-KEEP-LIVE-v0：碰/杠后两张孤张二选一，用牌河算存活账
// ---------------------------------------------------------------------------

/** 邻张已现越多 → 该孤张还留在墙里的概率越高，越容易摸成对 */
const KEEP_LIVE_MIN_NEIGHBORS = 2

function matchKeepLive(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const base = 13 - me.melds.length * 3
  if (me.hand.length !== base + 1 || !iJustMelded(state, self, 3))
    return null
  const iso = uniqueTiles(isolatedTiles(me.hand))
  if (iso.length < 2)
    return null
  const scored = iso.map(t => {
    let neighbors = 0
    for (const delta of [-2, -1, 1, 2]) {
      const v = t.value + delta
      if (v >= 1 && v <= 9)
        neighbors += seenCount(state, t.type, v)
    }
    return { tile: t, neighbors }
  }).sort((a, b) => b.neighbors - a.neighbors)
  const keep = scored[0]
  const drop = scored[scored.length - 1]
  if (keep === undefined || drop === undefined || keep.neighbors < KEEP_LIVE_MIN_NEIGHBORS || keep.neighbors === drop.neighbors)
    return null
  return {
    windowKind: 'discard',
    headline: `两张孤张 ${scored.map(s => tileLabel(s.tile)).join('、')}：留${tileLabel(keep.tile)}打${tileLabel(drop.tile)}`,
    advice: `刚碰/杠完要丢孤张，这个时候别凭手感挑，用牌河算存活账：` +
      `${tileLabel(keep.tile)} 的邻张在桌上已经现了 ${keep.neighbors} 张，说明它这张还有更多可能留在墙里，` +
      `多留一下就多一个成对的机会；反过来${tileLabel(drop.tile)}周围信息少、也没人喂，` +
      `留着多半变成废张。注意对手如果是「拆搭子」（抱肚子）打法，这条推断要反过来。`,
    evidence: scored.map(s => `${tileLabel(s.tile)}：邻张已现 ${s.neighbors} 张`).slice(0, 4),
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-CHECK-DINGQUE-BEFORE-PONG-v0：早期碰牌前先看全缺章
// ---------------------------------------------------------------------------

/** 早期阈值：全场弃牌合计不超过这么多张时，各家缺章还没在这一局里显露出来 */
const EARLY_PONG_MAX_DISCARDS = 12

function matchCheckDingqueBeforePong(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const window = state.responseWindow
  if (window === null || window.kind !== 'discard' || window.sourcePlayer === self)
    return null
  if (window.choices[self]?.type !== 'peng')
    return null
  const totalDiscards = state.players.reduce((n, p) => n + p.discards.length, 0)
  if (totalDiscards > EARLY_PONG_MAX_DISCARDS)
    return null
  const target = window.tile
  const seat = seatLabelOf(self, window.sourcePlayer)
  const dq = state.players.map(p => `${seatLabelOf(self, p.id)}${p.dingque === null ? '?' : `缺${p.dingque}`}`).join('、')
  const conflict = state.players.filter(p => p.dingque === target.type).length
  return {
    windowKind: 'response',
    headline: `早期碰${tileLabel(target)}：先确认全桌缺章再动手`,
    advice: `碰牌是不可逆的开关，而开局才打了 ${totalDiscards} 张，各家缺章信息还没暴露够。` +
      `现在碰掉${tileLabel(target)}，等于把可能更好的方向锁死——` +
      `万一对面三家都缺${target.type}，这张${target.type}本来是白送的优势，你反而因为碰牌把它扔了。` +
      `先看一遍缺章：${dq}。若碰的方向与你的缺章优势一致，再放心碰。`,
    evidence: [
      `${seat}打出 ${tileLabel(target)}，你可碰`,
      `当前弃牌总量 ${totalDiscards} 张（≤ ${EARLY_PONG_MAX_DISCARDS}，判为早期）`,
      conflict > 1 ? `注意：已有 ${conflict} 家缺${target.type} → 碰这张会丢掉该门优势` : `尚未发现多家缺${target.type}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-BIGDANDIAO-VS-XIAJIAO-v0：单点大吊 vs 多路下叫，先算吊张差
// ---------------------------------------------------------------------------

/** 单吊路线要多出这么多活张才值得放弃多路 */
const BIG_DANDIAO_LIVE_EDGE = 2

function matchBigdandiaoVsXiajiao(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const plans = waitPlans(state.players[self], ctx.visible)
  if (plans.length < 2)
    return null
  const single = plans.find(p => p.waits.length === 1)
  const multi = plans.find(p => p.waits.length >= 2)
  if (single === undefined || multi === undefined)
    return null
  const singleWait = single.waits[0]
  if (singleWait === undefined)
    return null
  const gap = single.live - multi.live
  if (Math.abs(gap) > BIG_DANDIAO_LIVE_EDGE)
    return null
  const chooseSingle = gap > 0
  return {
    windowKind: 'discard',
    headline: chooseSingle
      ? `单吊${singleWait.label}吊张多 ${gap} 张 → 走大吊路线`
      : `大吊只多一点吊张，不如走多路下叫`,
    advice: chooseSingle
      ? `单点大吊${singleWait.label}能等 ${single.live} 张，比多路路线多 ${gap} 张，` +
        `优势虽不算巨大但方向明确，可以接受「少胡几家」换「更容易兑现」。` +
        `注意这个估算只押当前时点——外面的牌还在流动，别人可能先摸走吊张，是动态账不是死数字。`
      : `单吊${singleWait.label}看着唬人，实际只对${multi.waits.map(w => w.label).join('/')}的多路方案多 ${Math.abs(gap) === 0 ? '不了' : `${gap}`}` +
        `${gap === 0 ? '' : ''}太多张。差别只有一两张的时候，早下叫更值：` +
        `既拿到即时收益，也少给别家一手做大牌的时间。别为大吊吊死在一棵树上。`,
    evidence: [
      `单吊路线：${single.discard === null ? '不打' : `打${tileLabel(single.discard)}`} → ${singleWait.label}（活 ${single.live} 张）`,
      `多路路线：${multi.discard === null ? '不打' : `打${tileLabel(multi.discard)}`} → ${multi.waits.map(w => w.label).join('/')}（活 ${multi.live} 张）`,
      `判据：吊张差 ${gap}（≤${BIG_DANDIAO_LIVE_EDGE} → 走早下叫/多路；明显更多 → 走单吊）`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-ZIMO-OR-NOTHING-v0：中盘小胡点炮可以放过等自摸
// ---------------------------------------------------------------------------

const ZIMO_MIN_WALL = 20
const ZIMO_MIN_LIVE = 3
const ZIMO_MAX_HU_VALUE = 2

function matchZimoOrNothing(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const hu = myHuChoice(state, self)
  if (hu === null || hu.value > ZIMO_MAX_HU_VALUE)
    return null
  if (bigHandThreat(state, self) !== null)
    return null // 有大牌威胁时被 R-THREAT-ESCAPE 接管
  const wallLeft = state.wall.length
  if (wallLeft < ZIMO_MIN_WALL)
    return null
  const best = waitPlans(state.players[self], ctx.visible)[0]
  const live = best?.live ?? 0
  if (live < ZIMO_MIN_LIVE)
    return null
  const seat = seatLabelOf(self, hu.sourcePlayer)
  return {
    windowKind: 'response',
    headline: `${seat}打出${tileLabel(hu.tile)}只值 ${hu.value} 分：预设自摸就走，点炮不胡`,
    advice: `这是个典型的「期望差掰手腕」局面：点炮收 ${hu.value} 分，而自摸能收好几家、` +
      `带上自摸加番，收益差不止一倍。牌墙还有 ${wallLeft} 张、你的存活张有 ${live} 张，` +
      `自摸窗口还开着。开局就该把这条预设写死：自摸即走，别人点炮的小胡不接。` +
      `当然，一旦牌局将尽或者外面有大牌威胁成型，这条预设要立刻作废、改成点炮就走。`,
    evidence: [
      `${seat}打出 ${tileLabel(hu.tile)}：点炮 ${hu.value} 分`,
      `牌墙剩 ${wallLeft} 张（≥ ${ZIMO_MIN_WALL}），存活张 ${live} 张（≥ ${ZIMO_MIN_LIVE}）`,
      `未检测到对手大牌成势 → 等自摸成立`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-EV-DECLINE-HU-v0：尾盘点炮用 EV 算放过 vs 胡
// ---------------------------------------------------------------------------

const EV_LATE_WALL = 10
/** 自摸相对点炮的收益倍数（川麻自摸普遍加番，保守估计） */
const EV_SELF_DRAW_MULTIPLIER = 2

function matchEvDeclineHu(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const hu = myHuChoice(state, self)
  if (hu === null)
    return null
  const wallLeft = state.wall.length
  if (wallLeft > EV_LATE_WALL)
    return null
  const best = waitPlans(state.players[self], ctx.visible)[0]
  const live = best?.live ?? 0
  if (live <= 0)
    return null
  const drawChance = Math.min(1, live / Math.max(wallLeft, 1))
  const huEv = hu.value
  const passEv = drawChance * hu.value * EV_SELF_DRAW_MULTIPLIER
  const seat = seatLabelOf(self, hu.sourcePlayer)
  const passIsBetter = passEv > huEv
  return {
    windowKind: 'response',
    headline: passIsBetter
      ? `尾盘点炮 ${hu.value} 分：算 EV，放过自摸更划算`
      : `尾盘点炮 ${hu.value} 分：算 EV，直接胡更稳`,
    advice: `把账摆出来：现在胡 = ${hu.value} 分；放过 = 在 ${wallLeft} 张牌墙里摸到 ${live} 张有效牌` +
      `（约 ${(drawChance * 100).toFixed(0)}%），自摸加番后期望约 ${passEv.toFixed(1)} 分。` +
      (passIsBetter
        ? `期望更高那条明明是放过，那就别急着把这一炮收了——用概率和期望来指导你的打法。`
        : `摸到的概率已经掉下来了，这时候再赌自摸就是把期望扔了，直接胡。`),
    evidence: [
      `${seat}打出${tileLabel(hu.tile)}：点炮 ${hu.value} 分`,
      `牌墙剩 ${wallLeft} 张；有效存活 ${live} 张 → 自摸概率约 ${(drawChance * 100).toFixed(0)}%`,
      `EV 对比：胡 ${huEv.toFixed(1)} vs 放过 ${passEv.toFixed(1)}（自摸按 ${EV_SELF_DRAW_MULTIPLIER} 倍估）`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-NO-RELY-CROWDED-SUIT-v0：四家都要的门别抱指望
// ---------------------------------------------------------------------------

const CROWDED_MIN_MY_TILES = 5

function matchNoRelyCrowdedSuit(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  if (state.players.some(p => p.dingque === null))
    return null
  const best = waitPlans(me, ctx.visible)[0]
  if (best === undefined)
    return null
  const waitSuit = SUITS.find(s => best.waits.every(w => w.label.endsWith(s)))
  if (waitSuit === undefined)
    return null
  if (collectorCount(state, waitSuit) < 4 || countSuit(me.hand, waitSuit) < CROWDED_MIN_MY_TILES)
    return null
  const others = SUITS.filter(s => s !== waitSuit && s !== me.dingque)
  return {
    windowKind: 'discard',
    headline: `${waitSuit}门四家都要 → 别把希望压在${best.waits.map(w => w.label).join('/')}`,
    advice: `你手上${waitSuit}看着有 ${countSuit(me.hand, waitSuit)} 张，但${waitSuit}是四家都要的门——` +
      `外面三家都在收，${best.waits.map(w => w.label).join('、')} 这种张被截胡的概率极高，基本没有指望。` +
      `别被「看着很多」骗了，改从${others.join('或')}门重新找下叫路线。`,
    evidence: [
      `收${waitSuit}门：4 家（无人缺该门）`,
      `你手上${waitSuit} ${countSuit(me.hand, waitSuit)} 张，当前叫口全在${waitSuit}门`,
      `存活张 ${best.live} 张，但要和三家抢`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-SIMPLE-ROUTE-FIRST-v0：简单稳健路线优先于复杂推断
// ---------------------------------------------------------------------------

const SIMPLE_MIN_WAITS = 2
const SIMPLE_MIN_LIVE = 3
const COMPLEX_MAX_REMAINING = 2

function matchSimpleRouteFirst(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const plans = waitPlans(state.players[self], ctx.visible)
  const simple = plans.find(p => p.waits.length >= SIMPLE_MIN_WAITS && p.live >= SIMPLE_MIN_LIVE)
  if (simple === undefined)
    return null
  const complex = plans.find(p => p.waits.length === 1 && p.waits[0]?.remaining !== undefined
    && (p.waits[0]?.remaining ?? 0) <= COMPLEX_MAX_REMAINING)
  if (complex === undefined)
    return null
  const wait = complex.waits[0]
  if (wait === undefined)
    return null
  return {
    windowKind: 'discard',
    headline: `与其深推${wait.label}，不如走${simple.waits.map(w => w.label).join('/')}的简单路线`,
    advice: `你现在有两条路：一条是赌${wait.label}（只剩 ${wait.remaining} 张，要靠一串推断才敢押），` +
      `一条是${simple.discard === null ? '不用改' : `打${tileLabel(simple.discard)}`}下` +
      `${simple.waits.map(w => w.label).join('/')}（${simple.waits.length} 种叫、活 ${simple.live} 张）。` +
      `后者多路且有量，属于「想明白也这么打、没想到也这么打」的稳妥路线，优先走它。` +
      `不是说深推断没用——等简单路线的叫明显死透了，再去想复杂的那一套。`,
    evidence: [
      `复杂推断路线：${complex.discard === null ? '不打' : `打${tileLabel(complex.discard)}`} → ${wait.label}（剩 ${wait.remaining} 张）`,
      `简单多路路线：${simple.discard === null ? '不打' : `打${tileLabel(simple.discard)}`} → ${simple.waits.map(w => w.label).join('/')}（活 ${simple.live} 张）`,
      `判据：单吊剩 ≤${COMPLEX_MAX_REMAINING} 张时，简单路线优先`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-MAX-LIVE-WAIT-v0：改叫时选存活张最多的叫口
// ---------------------------------------------------------------------------

const MAX_LIVE_MIN_GAP = 2

function matchMaxLiveWait(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const plans = waitPlans(state.players[self], ctx.visible)
  const top = plans[0]
  const second = plans[1]
  if (top === undefined || second === undefined || top.live <= 0)
    return null
  const gap = top.live - second.live
  if (gap < MAX_LIVE_MIN_GAP)
    return null
  const describeStr = (p: WaitPlan) =>
    `${p.discard === null ? '不打' : `打${tileLabel(p.discard)}`} → ${p.waits.map(w => w.label).join('/')}（活 ${p.live} 张）`
  return {
    windowKind: 'discard',
    headline: `同样能下叫：走活张最多的那条（多 ${gap} 张）`,
    advice: `两条路线都能下叫，但存活张差 ${gap} 张，这不是「风格偏好」的差距，是数学差距。` +
      `永远选存活张最多的叫口：${top.waits.map(w => w.label).join('/')}（活 ${top.live} 张）优于` +
      `${second.waits.map(w => w.label).join('/')}（活 ${second.live} 张）。` +
      `别因为「已经投入了」「刚才那手是这么打」就舍不得改口，也别用单局结果追认。`,
    evidence: [
      `推荐路线：${describeStr(top)}`,
      `次优路线：${describeStr(second)}`,
      `牌墙剩 ${state.wall.length} 张`,
    ],
    mainSuit: (top.waits[0]?.label.slice(-1) as TileType) ?? null,
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-SINGLE-LINE-ATTACK-v0：缺章优势 → 制定进攻思路
// ---------------------------------------------------------------------------

const SINGLE_LINE_MIN_TILES = 5

function matchSingleLineAttack(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  if (me.dingque === null || state.players.some(p => p.dingque === null))
    return null
  const suit = SUITS.find(s => s !== me.dingque
    && countSuit(me.hand, s) >= SINGLE_LINE_MIN_TILES
    && collectorCount(state, s) === 1)
  if (suit === undefined)
    return null
  return {
    windowKind: 'any',
    headline: `外面三家缺${suit} → ${suit}门必须转为进攻思路`,
    advice: `${suit}门只有你一家收，其他三家都在打缺，等于整条${suit}子河都往你这儿灌。` +
      `这种牌面别满足于「赶紧下叫跑路」，该按进攻思路打：优先把${suit}门里的对子腾出来碰、成型做坎，` +
      `照着往大了做。反之，如果某门是三家在收，那才要切回「追下叫效率」的常规打法——这条必须反过来执行。`,
    evidence: [
      `收${suit}门：仅 1 家（你自己）`,
      `你手上${suit} ${countSuit(me.hand, suit)} 张（≥ ${SINGLE_LINE_MIN_TILES}）`,
      `缺章结构：${state.players.map(p => `${seatLabelOf(self, p.id)}${p.dingque === null ? '?' : `缺${p.dingque}`}`).join('、')}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-BIGWAIT-COST-v0：做大牌前先算喂牌代价
// ---------------------------------------------------------------------------

const BIGWAIT_MIN_COLLECTORS = 3

function matchBigwaitCost(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  if (state.players.some(p => p.dingque === null))
    return null
  const plans = waitPlans(me, ctx.visible)
  const big = plans.find(p => p.waits.length === 1)
  if (big === undefined)
    return null
  const wait = big.waits[0]
  if (wait === undefined)
    return null
  const waitSuit = SUITS.find(s => wait.label.endsWith(s))
  if (waitSuit === undefined || collectorCount(state, waitSuit) < BIGWAIT_MIN_COLLECTORS)
    return null
  const alternatives = plans.filter(p => p.waits.length >= 2 && p.live >= big.live)
  if (alternatives.length === 0)
    return null
  const alt = alternatives[0]
  if (alt === undefined)
    return null
  return {
    windowKind: 'discard',
    headline: `做大单钓${wait.label}的代价：先把${waitSuit}门喂出去了`,
    advice: `要押${wait.label}做大牌，就得先拆${waitSuit}门的搭子—而${waitSuit}门有 ` +
      `${collectorCount(state, waitSuit)} 家在收，你拆一张等于给三家送一份。还没等大牌做成，` +
      `肥羊就放跑完了。相比之下${alt.waits.map(w => w.label).join('/')}的现成叫口也在那儿，` +
      `宁可少番，先收了这一把再说。`,
    evidence: [
      `大牌路线：${big.discard === null ? '不打' : `打${tileLabel(big.discard)}`} → 单钓${wait.label}（活 ${big.live} 张）`,
      `现成路线：${alt.discard === null ? '不打' : `打${tileLabel(alt.discard)}`} → ${alt.waits.map(w => w.label).join('/')}（活 ${alt.live} 张）`,
      `喂牌代价：${waitSuit}门 ${collectorCount(state, waitSuit)} 家在收（≥ ${BIGWAIT_MIN_COLLECTORS}）`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-COUNTER-BIG-DANDIAO-v0：对手单钓 → 走大对子多路压制
// ---------------------------------------------------------------------------

const COUNTER_MIN_PAIRS = 3

function matchCounterBigDandiao(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const threat = bigHandThreat(state, self)
  if (threat === null)
    return null
  const me = state.players[self]
  const pairs = pairsOf(me.hand)
  if (pairs.length < COUNTER_MIN_PAIRS)
    return null
  const tp = state.players[threat]
  const seat = seatLabelOf(self, threat)
  const resources = pairs.length + me.melds.length
  return {
    windowKind: 'discard',
    headline: `${seat}在赌大单钓 → 你手上 ${pairs.length} 对，改做大对子多路压他`,
    advice: `${seat}副露已成型，路线基本是单钓大牌，叫口窄要靠你自己送上。对付这种牌,` +
      `最硬的办法不是躲，而是改走大对子：你手上已经是 ${pairs.map(p => tileLabel(p.tile)).join('、')} 这些活对子，` +
      `碰出一个就多一个叫口，做成多路以后他自己必点——手上全是活对子的时候，做大对就是压制大单钓最好的办法。` +
      `注意别为了躲他把少一番的张先打了（比如为了安全打掉中张），那不是这里的正确解。`,
    evidence: [
      `${seat}副露 ${tp.melds.length} 副（${dominantMeldSuit(tp.melds)?.type ?? '分散'}门）→ 大牌路线`,
      `你的对子：${pairs.map(p => tileLabel(p.tile)).join('、')}（${pairs.length} 对）`,
      `可用资源：对子 ${pairs.length} + 已有副露 ${me.melds.length} = ${resources}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-LAW-TWO-NO-WAIT-v0：两家不要就下这个叫
// ---------------------------------------------------------------------------

/** 两三家不要就该顺着下；活张差距超过这个值就不强变 */
const TWO_NO_WAIT_MAX_LIVE_LOSS = 1

function matchLawTwoNoWait(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  if (me.dingque === null || state.players.some(p => p.dingque === null))
    return null
  const plans = waitPlans(me, ctx.visible)
  const top = plans[0]
  if (top === undefined)
    return null
  for (const suit of SUITS) {
    if (suit === me.dingque || collectorCount(state, suit) > 2)
      continue
    const better = plans.find(p => p.waits.some(w => w.label.endsWith(suit)) && p.live >= top.live - TWO_NO_WAIT_MAX_LIVE_LOSS)
    if (better === undefined)
      continue
    if (top.waits.every(w => w.label.endsWith(suit)))
      continue
    return {
      windowKind: 'discard',
      headline: `${suit}门只有 ${collectorCount(state, suit)} 家要 → 把叫换到${suit}方向`,
      advice: `破第一条习惯：能够变叫的时候，尽量把叫朝着「两家不要」的方向去下。` +
        `${suit}门现在只有 ${collectorCount(state, suit)} 家在收，等于对你开放；` +
        `而且这里也能下叫（${better.waits.map(w => w.label).join('/')}，活 ${better.live} 张），` +
        `不至于为了变叫把牌打残。当然要根据牌面尽力为之——如果变叫之后胡张很薄、或者被杠断，就别强行变。`,
      evidence: [
        `收${suit}门：${collectorCount(state, suit)} 家（≤2 → 「两家不要」成立）`,
        `可行路线：${better.discard === null ? '不打' : `打${tileLabel(better.discard)}`} → ${better.waits.map(w => w.label).join('/')}（活 ${better.live} 张）`,
        `当前路线：${top.waits.map(w => w.label).join('/')}（活 ${top.live} 张）`,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-DROP-FUTURE-RISK-v0：留久成祸的张要早打
// ---------------------------------------------------------------------------

const FUTURE_RISK_MIN_DISCARDS = 6
const FUTURE_RISK_MAX_REMAINING = 2

function matchDropFutureRisk(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const base = 13 - me.melds.length * 3
  if (me.hand.length !== base + 1)
    return null
  const iso = uniqueTiles(isolatedTiles(me.hand))
  for (const tile of iso) {
    const remaining = 4 - seenCount(state, tile.type, tile.value) - countSuit(me.hand.filter(t => sameTile(t, tile)), tile.type)
    if (remaining > FUTURE_RISK_MAX_REMAINING)
      continue
    // 有对手在收这门（不缺且几乎不打这门）→ 他很可能把这个隐患摸成对
    for (const id of opponentsOf(self)) {
      const p = state.players[id]
      // 定缺未清的对手没有选择权：前期弃牌被缺门占满，其它门弃得少是规则使然，
      // 不能读成「在收某门」（2026-09-11 实测误报：定缺万者 10 弃 1 筒被判「在收筒」）。
      // 只读他「清缺之后」打出的牌——最后一张缺门之后的弃牌才是真实取舍。
      const dq = p.dingque
      if (dq === null || dq === tile.type)
        continue
      if (p.discards.length < FUTURE_RISK_MIN_DISCARDS)
        continue
      let lastQueIdx = -1
      p.discards.forEach((t, i) => { if (t.type === dq) lastQueIdx = i })
      const postClean = p.discards.slice(lastQueIdx + 1)
      if (postClean.length < 3)
        continue
      if (countSuit(postClean, tile.type) > 0)
        continue
      const seat = seatLabelOf(self, id)
      return {
        windowKind: 'discard',
        headline: `${tileLabel(tile)}留久了成祸：${seat}在收${tile.type}，早打`,
        advice: `${tileLabel(tile)}在你手上是张孤张，自己基本不上；而${seat}清完缺门之后` +
          `打出的 ${postClean.length} 张里，${tile.type}门一张没有——他在收${tile.type}。` +
          `这种「我自己不好上、别人摸成对就反过来打我」的张，留久了反而成祸患——趁现在墙里还剩不多，` +
          `早点打掉，把位置留给质量更好的搭子方向。`,
        evidence: [
          `${tileLabel(tile)}是孤张，墙里最多剩 ${remaining} 张`,
          `${seat}清缺后已打 ${postClean.length} 张、${tile.type}门 0 张 → 在收该门`,
        ],
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-PAIR-COUNT-DOWN-v0：不做七对时对子多是负担
// ---------------------------------------------------------------------------

const TOO_MANY_PAIRS = 4
const TOO_MANY_PAIRS_CONCEALED = 5

function matchPairCountDown(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const pairs = pairsOf(me.hand)
  // 有副露就肯定不是七对；无副露则要求对子多到很难走七对
  const overloaded = me.melds.length > 0 ? pairs.length >= TOO_MANY_PAIRS : pairs.length >= TOO_MANY_PAIRS_CONCEALED
  if (!overloaded)
    return null
  const best = waitPlans(me, ctx.visible)[0]
  return {
    windowKind: 'discard',
    headline: `手上 ${pairs.length} 对又不是做七对 → 对子是负担，该拆`,
    advice: `不做七对的时候，对子多了并不是好事。你现在 ${pairs.map(p => tileLabel(p.tile)).join('、')}` +
      `共 ${pairs.length} 对，整手牌被占掉了 ${pairs.length * 2} 张位置，结果是下不去叫也躲不开外面的大牌。` +
      `目标要明确：为了尽早下叫、躲过外面的大牌，该拆的对子就得拆。` +
      (best === undefined ? '' : `当前最佳叫口活张仅 ${best.live} 张，正是对子占位的代价。`),
    evidence: [
      `对子：${pairs.map(p => tileLabel(p.tile)).join('、')}（${pairs.length} 对）`,
      `已有副露 ${me.melds.length} 副${me.melds.length === 0 ? '（仍可走七对，但对子已超阈值）' : '（已不能走七对）'}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-CHOOSE-PAIR-TO-BREAK-v0：拆对四判据
// ---------------------------------------------------------------------------

const CHOOSE_PAIR_MIN = 4

function matchChoosePairToBreak(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const pairs = pairsOf(me.hand)
  if (pairs.length < CHOOSE_PAIR_MIN)
    return null
  // 判据②：生张边张（幺九）最难碰出/最难成坎 → 优先拆；没有边张对时才谈拆中张
  const ranked = pairs
    .map(p => ({
      tile: p.tile,
      edge: p.tile.value === 1 || p.tile.value === 9,
      seen: seenCount(state, p.tile.type, p.tile.value),
    }))
    .sort((a, b) => Number(b.edge) - Number(a.edge) || b.seen - a.seen)
  const victim = ranked[0]
  if (victim === undefined || !victim.edge)
    return null
  // 该对必须与手牌其余部分没有联动（同门 ±2 内没有别的张）：联动着的中张对先不动
  const interacts = me.hand.some(t =>
    t.type === victim.tile.type && !sameTile(t, victim.tile) && Math.abs(t.value - victim.tile.value) <= 2)
  if (interacts)
    return null
  const keep = ranked[ranked.length - 1]
  if (keep === undefined)
    return null
  return {
    windowKind: 'discard',
    headline: `必须拆一对时：先拆${tileLabel(victim.tile)}，别因为「它安全」舍不得`,
    advice: `拆对不是挑最危险的张打——虽然${tileLabel(victim.tile)}看着危险（${victim.edge ? '幺九边张' : '生张'}、河里才 ${victim.seen} 张），` +
      `但正因为难上，它才是最该拆的——要用它碰出或摸成坎的概率最低。` +
      `四条判据记牢：① 先锁死那些「极大概率能碰」的对；② 生张边张最容易崩对，优先拆；` +
      `③ 对手在做七对时，他摸不上来的张早晚会打出来，那类对反而可以留；` +
      `④ 别因为「这张打出去安全」就拆错对——安全不等于正确。`,
    evidence: [
      `候选对：${ranked.map(r => `${tileLabel(r.tile)}(河里${r.seen}张${r.edge ? '，幺九边张' : ''})`).join('、')}`,
      `建议开刀：${tileLabel(victim.tile)}；锁死保留：${tileLabel(keep.tile)}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-HIGH-DEEP-NO-UP-v0：高张太深就别指望上高张
// ---------------------------------------------------------------------------

const HIGH_VALUES = [7, 8, 9] as const
const LOW_VALUES = [1, 2, 3] as const
/** 开局大家还没打牌，所有牌都「一张未现」——那不是深，是没信息 */
const HIGH_DEEP_MIN_DISCARDS = 12

function matchHighDeepNoUp(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const totalDiscards = state.players.reduce((n, p) => n + p.discards.length, 0)
  if (totalDiscards < HIGH_DEEP_MIN_DISCARDS)
    return null
  const best = waitPlans(me, ctx.visible)[0]
  if (best === undefined)
    return null
  for (const suit of SUITS) {
    const waitHigh = best.waits.filter(w => w.label.endsWith(suit) && HIGH_VALUES.some(v => v === Number(w.label.charAt(0))))
    if (waitHigh.length === 0)
      continue
    if (HIGH_VALUES.some(v => seenCount(state, suit, v) > 0))
      continue
    const lowTiles = me.hand.filter(t => t.type === suit && LOW_VALUES.some(v => v === t.value))
    if (lowTiles.length < 2)
      continue
    return {
      windowKind: 'discard',
      headline: `${suit}门七八九张一张都没出来 → 别指望上${waitHigh.map(w => w.label).join('/')}`,
      advice: `桌面上的${suit}高张非常深：7、8、9 一张都没露面，说明不是没人要，是全被人捏在手里。` +
        `你指望摸${waitHigh.map(w => w.label).join('或')}来下叫，等于在等人施舍。改走低张方向，` +
        `再利用一下骗张——比如打掉同门的高张，说不定还能把对手捏着的${waitHigh.map(w => w.label).join('/')}骗出来。`,
      evidence: [
        `${suit}门 7/8/9 河里现 0 张 → 高张深度极高`,
        `当前叫口依赖高张：${waitHigh.map(w => w.label).join('、')}`,
        `手上${suit}门低张 ${lowTiles.map(tileLabel).join('、')}（可改走低张路线）`,
      ],
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行器 R-NO-ARMS-RACE-v0：多家做大时不加入军备竞赛
// ---------------------------------------------------------------------------

const ARMS_RACE_MIN_PLAYERS = 2
/** 自己也明确在押某一门（手上该门不少于这么多张）才算「有做大牌的念头」 */
const ARMS_RACE_MIN_MY_TILES = 6

function matchNoArmsRace(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const bigs = opponentsOf(self).filter(id => {
    const p = state.players[id]
    if (p.hasWon)
      return false
    const dom = dominantMeldSuit(p.melds)
    return dom !== null && dom.count >= 2
  })
  if (bigs.length < ARMS_RACE_MIN_PLAYERS)
    return null
  const mySuit = SUITS.find(s => countSuit(me.hand, s) >= ARMS_RACE_MIN_MY_TILES)
  if (mySuit === undefined)
    return null
  const seats = bigs.map(id => seatLabelOf(self, id)).join('、')
  return {
    windowKind: 'any',
    headline: `${seats}都在做大牌 → 别加入军备竞赛，转稳健下叫`,
    advice: `${bigs.length} 家已经摆明了做大牌（${bigs.map(id => `${seatLabelOf(self, id)}砸${dominantMeldSuit(state.players[id].melds)?.type ?? '?'}门`).join('、')}），` +
      `这时候你手上${mySuit}再有 ${countSuit(me.hand, mySuit)} 张也别去拼什么${mySuit}清一色了——` +
      `军备竞赛里慢一步就是炮台：人家速度和番型都在你前面，你还没成型就先要喂牌给别人。` +
      `除非你的关键张极早到位（起手就差一张的程度），否则放弃大牌路线，老老实实追下叫。`,
    evidence: [
      `已做大牌：${seats}（各 ≥2 副同门副露）`,
      `你的潜在路线：${mySuit}门 ${countSuit(me.hand, mySuit)} 张（≥ ${ARMS_RACE_MIN_MY_TILES}）`,
      `牌墙剩 ${state.wall.length} 张`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-QING-TRAP-v0：清一色陷阱，先算必备张存活
// ---------------------------------------------------------------------------

const QING_TRAP_MIN_TILES = 8
const QING_TRAP_MAX_LIVE = 1
/** 开局就说「做不成」是伪判断：至少等各家打过一轮牌再谈关键张被绝 */
const QING_TRAP_MIN_DISCARDS = 12

function matchQingTrap(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const base = 13 - me.melds.length * 3
  if (me.hand.length !== base + 1)
    return null
  const totalDiscards = state.players.reduce((n, p) => n + p.discards.length, 0)
  if (totalDiscards < QING_TRAP_MIN_DISCARDS)
    return null
  const suit = SUITS.find(s => s !== me.dingque && countSuit(me.hand, s) >= QING_TRAP_MIN_TILES)
  if (suit === undefined)
    return null
  const best = waitPlans(me, ctx.visible)[0]
  const live = best?.live ?? 0
  if (live > QING_TRAP_MAX_LIVE)
    return null
  const deadWaits = (best?.waits ?? []).filter(w => w.remaining === 0)
  return {
    windowKind: 'discard',
    headline: `${suit}门 ${countSuit(me.hand, suit)} 张在手：这副清一色做出来是给大家看的`,
    advice: `陷阱在这儿：做${suit}清一色需要连摸好几个关键张，而现在这些张要么已经被打绝、` +
      `要么全绝在你自己手上（你自己占着，别人没法喂你）。当前最佳叫口只剩 ${live} 张，` +
      (deadWaits.length > 0 ? `其中${deadWaits.map(w => w.label).join('、')}已经完全死掉。` : '') +
      `这种情况下再做下去，做出来就是给大家看的——趁早转稳健路线，先把下叫落实了。`,
    evidence: [
      `手上${suit}门 ${countSuit(me.hand, suit)} 张（≥ ${QING_TRAP_MIN_TILES} 属伪装性的「看着能做」）`,
      `当前最佳叫口活张仅 ${live} 张（≤ ${QING_TRAP_MAX_LIVE}）`,
      `牌墙剩 ${state.wall.length} 张`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-EXPECT-MINDSET-v0：期望收益意识，结果不改打法
// ---------------------------------------------------------------------------

const EXPECT_MINDSET_EVENT_WINDOW = 12

function matchExpectMindset(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  if (!iJustPassedWin(state, self, EXPECT_MINDSET_EVENT_WINDOW))
    return null
  const best = waitPlans(state.players[self], ctx.visible)[0]
  return {
    windowKind: 'any',
    headline: '刚放的那手：别让结果改了你的打法',
    advice: `你刚刚过了一张可以做的事——现在最危险的是下一张牌开始后悔。` +
      `打牌必须有期望收益意识：当时按概率和期望做出的选择是对的，就算这一局被结果打了脸，` +
      `下一次同样的局面还是要这么打。改用长期进分来衡量，而不是用单局的输赢追认。` +
      (best === undefined ? '' : ` 现在这一手，按期望仍然是${best.waits.map(w => w.label).join('/')}（活 ${best.live} 张）这条路更划算。`),
    evidence: [
      '检测到你刚刚放过一次和牌机会（passed_win）',
      '触发期望收益提醒：按长期主义执行，不追认单局结果',
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-NO-ZHANG-PLAN-v0：不上牌时，下叫优先并兼顾防守
// ---------------------------------------------------------------------------

const NO_ZHANG_MIN_ISO = 3
const NO_ZHANG_MAX_LIVE = 2

function matchNoZhangPlan(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  const best = waitPlans(me, ctx.visible)[0]
  const live = best?.live ?? 0
  if (live > NO_ZHANG_MAX_LIVE)
    return null
  const iso = uniqueTiles(isolatedTiles(me.hand))
  if (iso.length < NO_ZHANG_MIN_ISO)
    return null
  return {
    windowKind: 'discard',
    headline: `摸不上牌（孤张 ${iso.length} 张、活张 ${live}）→ 重估单牌搭子取舍`,
    advice: `这局你明显在打「卡」：孤张有 ${iso.map(tileLabel).join('、')}，最佳叫口只剩 ${live} 张。` +
      `这种局面要把注意力放在两件事上：一是单牌和搭子到底怎么取舍，尽量提高下叫机会；` +
      `二是别因为自己不上牌就全不管别人——盯着对手的牌河，别让别家轻易坐大。`,
    evidence: [
      `孤张：${iso.map(tileLabel).join('、')}（${iso.length} 张 ≥ ${NO_ZHANG_MIN_ISO}）`,
      `最佳叫口活张 ${live} 张（≤ ${NO_ZHANG_MAX_LIVE}）`,
      `牌墙剩 ${state.wall.length} 张`,
    ],
  }
}

// ---------------------------------------------------------------------------
// 执行器 R-DROP-DEAD-PAIR-v0：死对先打别舍不得
// ---------------------------------------------------------------------------

const DEAD_PAIR_NEWS_WINDOW = 8

/** 最近 n 个事件里这张牌是否刚露过面——用来判断「刚成为死对」，避免每回合重复提醒 */
function tileAppearedRecently(state: GameState, tile: TileInstance, within: number): boolean {
  const start = Math.max(0, state.events.length - within)
  for (let i = state.events.length - 1; i >= start; i--) {
    const ev = state.events[i]
    if (ev === undefined)
      continue
    if (ev.type === 'tile_discarded' && sameTile(ev.tile, tile))
      return true
    if (ev.type === 'meld_declared' && ev.meld.tiles.some(t => sameTile(t, tile)))
      return true
  }
  return false
}

function matchDropDeadPair(ctx: RuleContext): RuleHit | null {
  const { state, self } = ctx
  const me = state.players[self]
  for (const pair of pairsOf(me.hand)) {
    const mine = me.hand.filter(t => sameTile(t, pair.tile)).length
    const remaining = 4 - seenCount(state, pair.tile.type, pair.tile.value) - mine
    if (remaining > 0)
      continue
    // 只在「刚刚绝」的时候提醒一次：之后每回合都喊一遍就成了噪音
    if (!tileAppearedRecently(state, pair.tile, DEAD_PAIR_NEWS_WINDOW))
      continue
    const best = waitPlans(me, ctx.visible)[0]
    return {
      windowKind: 'discard',
      headline: `${tileLabel(pair.tile)}已经是死对 → 早点打掉腾位置`,
      advice: `${tileLabel(pair.tile)}墙里再没有了（你自己 ${mine} 张 + 桌上已现 ${seenCount(state, pair.tile.type, pair.tile.value)} 张 = 4），` +
        `留着只能占两个位置、等不到第三次。死锁的对先打掉，把位置腾给还活着的方向。` +
        (best === undefined ? '' : ` 顺便留意：你当前的叫口是${best.waits.map(w => w.label).join('/')}，` +
          `如果哪张胡张也被打绝了，要随时准备换叫。`),
      evidence: [
        `${tileLabel(pair.tile)}：你手上 ${mine} 张 + 已现 ${seenCount(state, pair.tile.type, pair.tile.value)} 张 = 4 张全部锁定`,
      ],
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
  // 第二批改判定化：期望 / 选叫 / 对子取舍 / 心态
  { ruleId: 'R-THREAT-ESCAPE-v0', run: matchThreatEscape },
  { ruleId: 'R-KEEP-LIVE-v0', run: matchKeepLive },
  { ruleId: 'R-CHECK-DINGQUE-BEFORE-PONG-v0', run: matchCheckDingqueBeforePong },
  { ruleId: 'R-BIGDANDIAO-VS-XIAJIAO-v0', run: matchBigdandiaoVsXiajiao },
  { ruleId: 'R-ZIMO-OR-NOTHING-v0', run: matchZimoOrNothing },
  { ruleId: 'R-EV-DECLINE-HU-v0', run: matchEvDeclineHu },
  { ruleId: 'R-NO-RELY-CROWDED-SUIT-v0', run: matchNoRelyCrowdedSuit },
  { ruleId: 'R-SIMPLE-ROUTE-FIRST-v0', run: matchSimpleRouteFirst },
  { ruleId: 'R-MAX-LIVE-WAIT-v0', run: matchMaxLiveWait },
  { ruleId: 'R-SINGLE-LINE-ATTACK-v0', run: matchSingleLineAttack },
  { ruleId: 'R-BIGWAIT-COST-v0', run: matchBigwaitCost },
  { ruleId: 'R-COUNTER-BIG-DANDIAO-v0', run: matchCounterBigDandiao },
  { ruleId: 'R-LAW-TWO-NO-WAIT-v0', run: matchLawTwoNoWait },
  { ruleId: 'R-DROP-FUTURE-RISK-v0', run: matchDropFutureRisk },
  { ruleId: 'R-PAIR-COUNT-DOWN-v0', run: matchPairCountDown },
  { ruleId: 'R-CHOOSE-PAIR-TO-BREAK-v0', run: matchChoosePairToBreak },
  { ruleId: 'R-HIGH-DEEP-NO-UP-v0', run: matchHighDeepNoUp },
  { ruleId: 'R-NO-ARMS-RACE-v0', run: matchNoArmsRace },
  { ruleId: 'R-QING-TRAP-v0', run: matchQingTrap },
  { ruleId: 'R-EXPECT-MINDSET-v0', run: matchExpectMindset },
  { ruleId: 'R-NO-ZHANG-PLAN-v0', run: matchNoZhangPlan },
  { ruleId: 'R-DROP-DEAD-PAIR-v0', run: matchDropDeadPair },
]

/**
 * 抑制表：key 规则在同局中被 value 中任一规则命中时丢弃。
 * 用途：同一信号（如「对手副露集中的大牌」）会同时触发通用告警与具体动作，
 * 只保留更具体的那条，避免镜像导师刷屏。
 */
const SUPPRESSED_BY: Readonly<Record<string, readonly string[]>> = {
  'R-ESCAPE-AVOID-BIG-v0': ['R-ESCAPE-SWITCH-SUIT-v0'],
  'R-REBUILD-HAND-FROM-MELDS-v0': ['R-READ-BIG-DANDIAO-v0'],
  // 同一局面只会有一条「选叫」建议：更具体的那条压住通用的那条
  'R-MAX-LIVE-WAIT-v0': ['R-BIGDANDIAO-VS-XIAJIAO-v0'],
  'R-ENUM-PROB-CHOICE-v0': ['R-BIGDANDIAO-VS-XIAJIAO-v0'],
  'R-SIMPLE-ROUTE-FIRST-v0': ['R-MAX-LIVE-WAIT-v0'],
  // 放一手的三部曲：有大牌威胁最具体，尾盘 EV 次之，通用底线垫底
  'R-SET-BOTTOM-LINE-v0': ['R-ZIMO-OR-NOTHING-v0', 'R-EV-DECLINE-HU-v0', 'R-THREAT-ESCAPE-v0'],
  'R-ZIMO-OR-NOTHING-v0': ['R-THREAT-ESCAPE-v0', 'R-EV-DECLINE-HU-v0'],
  // 对子取舍：给出「拆哪一对」后就不再重复喊「对子多了」
  'R-PAIR-COUNT-DOWN-v0': ['R-CHOOSE-PAIR-TO-BREAK-v0'],
  // 早管一张的事：死锁对优先于通用「早打孤张」
  'R-DROP-FUTURE-RISK-v0': ['R-DROP-DEAD-PAIR-v0'],
  'R-EARLY-SAFE-DISCARD-v0': ['R-DROP-DEAD-PAIR-v0'],
}

/**
 * 一次最多返回的「决策类」建议（碰/胡/出牌这类要你立刻做动作的）。
 * 宁缺毋滥：镜像导师不抢破晓哥教练的主决策权。
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
 * 主入口：对一局公开可见状态，返回命中的破晓哥镜像建议。
 * - 未命中返回空数组（保持安静，不干预破晓哥教练的主建议）
 * - 决策类（response/discard）与观察类（any）分开限流，各自按置信度降序截断
 */
/**
 * 金句（案例原话）与当前局主门花色不一致时，生成桥接说明。
 * 例：破晓哥原话举「九条」的例子，但当前局是万子门 → 明确「这是案例花色、不是给你的指令，思路通用」。
 * 同花色、无主门、金句不含具体花色时返回 null（不展示桥接）。
 */
export function makeQuoteBridge(rule: XiaoshiRule, mainSuit: TileType | null): string | null {
  if (mainSuit === null)
    return null
  const quoteSuit = SUITS.find(s => rule.rationale.includes(s)) ?? null
  if (quoteSuit === null || quoteSuit === mainSuit)
    return null
  return `破晓哥这句原话举的是「${quoteSuit}子」的例子——这是案例里的花色，不是你当前手牌的指令。你这局对应的叫口在${mainSuit}子门，思路完全一致：同一门里永远优先选存活张最多的叫口，花色不同而已。`
}

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
    // 金句（案例原话）里的花色若与当前局主门不一致，生成桥接说明，避免「导师在让我选条子」的误读
    const quoteBridge = makeQuoteBridge(rule, hit.mainSuit ?? null)
    const { mainSuit: _drop, ...hitRest } = hit
    hits.push({
      ruleId,
      ruleName: rule.name,
      theme: rule.theme ?? null,
      quote: rule.rationale,
      boundary: rule.boundary ?? null,
      confidence: rule.confidence,
      ...hitRest,
      quoteBridge,
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
