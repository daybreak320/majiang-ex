import type { OpportunityResult } from '../knowledge/mahjongTheory'
import type { TileType } from '../types'
import type { GameState, PlayerId, TileInstance } from './types'
import { countOpportunities } from '../knowledge/mahjongTheory'
import { recommendDingque } from './core'
import { getLegalActions } from './engine'
import { MILESTONE_1_RULES } from './rules'

export type StrategicPosture = 'retreat' | 'steady' | 'press'

export interface StrategicReminder {
  posture: StrategicPosture
  title: string
  summary: string
  signals: string[]
  recommendedAction: 'pass' | null
  source: string
}

interface PureSuitPotential {
  type: TileType
  count: number
  share: number
  feederCount: number
}

interface SuitPush {
  playerId: PlayerId
  shedType: TileType
  count: number
}

export interface OpponentThreat {
  playerId: PlayerId
  position: string
  targetType: TileType
  meldCount: number
  hasClearedDingque: boolean
}

export type OpponentHandPossibility = 'qingyise' | 'duiduihu' | 'ordinary'

export interface EndgameOpponentInference {
  playerId: PlayerId
  position: string
  dingque: TileType | null
  clearedDingque: boolean
  possibilities: Array<{ kind: OpponentHandPossibility, label: string, confidence: 'high' | 'medium' | 'low', reason: string }>
  dangerTypes: TileType[]
  safeTypes: TileType[]
  caveat: string
}

export interface EndgameDefenseInference {
  active: boolean
  wallTiles: number
  premise: string
  opponents: EndgameOpponentInference[]
}

const EMPTY_OPPORTUNITY: OpportunityResult = { total: 0, waits: [], structuralWaits: [] }

function publicTiles(state: GameState): TileInstance[] {
  return state.players.flatMap(player => [
    ...player.discards,
    ...player.melds.flatMap(meld => meld.tiles),
    ...(player.hasWon ? player.hand : []),
  ])
}

function opportunityAfterBestDiscard(state: GameState, playerId: PlayerId): OpportunityResult {
  const player = state.players[playerId]
  const visible = publicTiles(state)
  const expectedHandCount = (4 - player.melds.length) * 3 + 1
  if (player.hand.length === expectedHandCount) {
    return countOpportunities(player.hand, visible, {
      dingque: player.dingque,
      melds: player.melds,
    })
  }
  if (player.hand.length !== expectedHandCount + 1)
    return EMPTY_OPPORTUNITY

  const unique = new Set<string>()
  let best = EMPTY_OPPORTUNITY
  const discards = getLegalActions(state, playerId).filter(action => action.type === 'discard')
  for (const discard of discards) {
    const tile = player.hand.find(candidate => candidate.id === discard.tileId)
    if (tile === undefined)
      continue
    const key = `${tile.type}-${tile.value}`
    if (unique.has(key))
      continue
    unique.add(key)
    const opportunity = countOpportunities(
      player.hand.filter(candidate => candidate.id !== tile.id),
      [...visible, tile],
      { dingque: player.dingque, melds: player.melds },
    )
    if (opportunity.total > best.total
      || (opportunity.total === best.total && opportunity.structuralWaits.length > best.structuralWaits.length)) {
      best = opportunity
    }
  }
  return best
}

function pureSuitPotential(state: GameState, playerId: PlayerId): PureSuitPotential | null {
  const player = state.players[playerId]
  if (player.dingque === null)
    return null
  const ownedTiles = [...player.hand, ...player.melds.flatMap(meld => meld.tiles)]
    .filter(tile => tile.type !== player.dingque)
  if (ownedTiles.length === 0)
    return null

  const ranked = MILESTONE_1_RULES.tileTypes
    .filter(type => type !== player.dingque)
    .map(type => ({ type, count: ownedTiles.filter(tile => tile.type === type).length }))
    .sort((a, b) => b.count - a.count)
  const dominant = ranked[0]
  const share = dominant.count / ownedTiles.length
  const meldsCompatible = player.melds.every(meld => meld.tiles.every(tile => tile.type === dominant.type))
  if (dominant.count < 8 || share < 0.7 || !meldsCompatible)
    return null

  return {
    type: dominant.type,
    count: dominant.count,
    share,
    feederCount: state.players.filter(candidate =>
      candidate.id !== playerId
      && !candidate.hasWon
      && candidate.dingque === dominant.type).length,
  }
}

function oppositeSuitPush(state: GameState, playerId: PlayerId, targetType: TileType): SuitPush | null {
  const oppositeId = ((playerId + 2) % 4) as PlayerId
  const opposite = state.players[oppositeId]
  if (opposite.hasWon || opposite.dingque === null || opposite.dingque === targetType)
    return null
  if (opposite.melds.some(meld => meld.tiles.some(tile => tile.type !== targetType)))
    return null

  const recent = opposite.discards.slice(-3)
  if (recent.length < 3 || recent.some(tile => tile.type !== recent[0].type))
    return null
  const shedType = recent[0].type
  if (shedType === opposite.dingque || shedType === targetType)
    return null
  const earlier = opposite.discards.slice(0, -3)
  if (!earlier.some(tile => tile.type === opposite.dingque))
    return null

  return { playerId: oppositeId, shedType, count: recent.length }
}

// 引擎按逆时针轮转：玩家 1 是你的上家，玩家 3 是你的下家；必须与桌面相对位置区分。
const PLAYER_POSITIONS: Record<PlayerId, string> = {
  0: '你',
  1: '上家',
  2: '对家',
  3: '下家',
}

/** 仅用公开副露、定缺与弃牌判断“睡宽床 / 清一色”危险，不读取对手暗牌。 */
export function detectOpponentThreats(state: GameState, playerId: PlayerId = 0): OpponentThreat[] {
  return state.players.flatMap((opponent): OpponentThreat[] => {
    if (opponent.id === playerId || opponent.hasWon || opponent.dingque === null || opponent.melds.length < 2)
      return []
    const meldTiles = opponent.melds.flatMap(meld => meld.tiles)
    const targetType = meldTiles[0]?.type
    if (targetType === undefined || targetType === opponent.dingque || meldTiles.some(tile => tile.type !== targetType))
      return []
    const hasClearedDingque = opponent.discards.some(tile => tile.type === opponent.dingque)
    if (!hasClearedDingque)
      return []
    return [{
      playerId: opponent.id,
      position: PLAYER_POSITIONS[opponent.id],
      targetType,
      meldCount: opponent.melds.length,
      hasClearedDingque,
    }]
  })
}

/**
 * 尾盘公开信息猜牌：只读取定缺、牌河、副露和自己的手牌。
 * “大家不能花猪、不能不听”仅是用户要求的终局压力前提，不能把未公开暗手推成确定牌型。
 */
export function inferEndgameDefense(state: GameState, playerId: PlayerId = 0, lateWall = 16): EndgameDefenseInference {
  const active = state.wall.length <= lateWall && state.phase !== 'dingque' && state.phase !== 'finished'
  const ownHand = state.players[playerId].hand
  const opponents = state.players.flatMap((opponent): EndgameOpponentInference[] => {
    if (opponent.id === playerId || opponent.hasWon)
      return []

    const clearedDingque = opponent.dingque !== null && opponent.discards.some(tile => tile.type === opponent.dingque)
    const meldTiles = opponent.melds.flatMap(meld => meld.tiles)
    const nonDingqueTypes = MILESTONE_1_RULES.tileTypes.filter(type => type !== opponent.dingque)
    const exposedByType = nonDingqueTypes.map(type => ({
      type,
      count: meldTiles.filter(tile => tile.type === type).length,
      river: opponent.discards.filter(tile => tile.type === type).length,
    }))
    const dominant = [...exposedByType].sort((a, b) => b.count - a.count || a.river - b.river)[0]
    const allMeldsSameType = meldTiles.length >= 2 && dominant !== undefined && dominant.count === meldTiles.length
    const tripletMelds = opponent.melds.filter(meld => meld.kind === 'peng' || meld.kind.includes('Gang')).length
    const possible: EndgameOpponentInference['possibilities'] = []

    if (allMeldsSameType && dominant !== undefined) {
      possible.push({
        kind: 'qingyise', label: `偏${dominant.type}门清一色`, confidence: clearedDingque ? 'high' : 'medium',
        reason: `公开副露 ${opponent.melds.length} 组都在${dominant.type}门${clearedDingque ? `，且已清${opponent.dingque}` : ''}；尾盘应把${dominant.type}门视作高危。`,
      })
    }
    if (tripletMelds >= 2) {
      possible.push({
        kind: 'duiduihu', label: '对对胡 / 碰碰胡倾向', confidence: tripletMelds >= 3 ? 'high' : 'medium', reason: `已公开 ${tripletMelds} 组刻子或杠子，剩余暗手很可能继续收对子或单吊。` })
    }
    if (possible.length === 0) {
      possible.push({ kind: 'ordinary', label: '普通听牌或快速收口', confidence: 'low', reason: `${clearedDingque ? `已清${opponent.dingque}` : '定缺尚未完全清出'}，但没有足够公开结构锁定大牌；仍需按尾盘听牌压力防守。` })
    }

    const dangerTypes = [...new Set(possible.filter(item => item.kind === 'qingyise').flatMap(() => dominant === undefined ? [] : [dominant.type]))]
    const safeTypes = opponent.dingque === null ? [] : [opponent.dingque]
    const ownHeldDanger = dangerTypes.filter(type => ownHand.some(tile => tile.type === type))
    return [{
      playerId: opponent.id,
      position: PLAYER_POSITIONS[opponent.id],
      dingque: opponent.dingque,
      clearedDingque,
      possibilities: possible,
      dangerTypes: ownHeldDanger,
      safeTypes,
      caveat: ownHeldDanger.length > 0
        ? `你手里仍有${ownHeldDanger.join('、')}，但“对手可能做该门”不等于每张都必点；优先结合现物、熟张与副露继续筛。`
        : '未从公开结构锁定特定危险门；优先找对手现物与已清定缺门。',
    }]
  })
  return {
    active,
    wallTiles: state.wall.length,
    premise: '按“各家都必须清定缺、尾盘都要争取听牌”作防守压力推演；只使用定缺、牌河、副露和你的手牌，不读取对手暗牌。',
    opponents,
  }
}

function lowValueDiscardWin(state: GameState, playerId: PlayerId, opportunity: OpportunityResult): boolean {
  const window = state.responseWindow
  if (state.phase !== 'responding'
    || window === null
    || window.kind !== 'discard'
    || window.isLastTile
    || window.isKongDiscard
    || state.wall.length < 12
    || opportunity.total < MILESTONE_1_RULES.copiesPerTile) {
    return false
  }
  const hu = getLegalActions(state, playerId).find(action => action.type === 'hu')
  return hu?.value === MILESTONE_1_RULES.baseScore
}

/**
 * 生成从定缺开始常驻的战略级提醒。规则是公开信息上的 MVP 启发式，不读取对手暗牌。
 * 来源：知识库 3.3、3.5、4.2、4.3、4.4；对应成都册第一章、第二章第四节、
 * 第三章“进攻、防守与综合”及第四章“番种秘籍”。
 */
export function buildStrategicReminder(state: GameState, playerId: PlayerId = 0): StrategicReminder {
  const player = state.players[playerId]
  if (player.dingque === null) {
    const recommendation = recommendDingque(player.hand)
    return {
      posture: 'steady',
      title: '先稳住',
      summary: `先定缺${recommendation}，再看同缺分布与庄家位置，不在信息不足时抢跑做大。`,
      signals: ['定缺尚未确认', `当前建议缺${recommendation}`],
      recommendedAction: null,
      source: '成都册第一章开局打法、知识库 4.4',
    }
  }

  const opportunity = opportunityAfterBestDiscard(state, playerId)
  const threats = detectOpponentThreats(state, playerId)

  // “睡宽床”已副露两组且清掉定缺：公开结构足以构成优先级最高的防守信号。
  if (threats.length > 0) {
    const threat = threats.sort((a, b) => b.meldCount - a.meldCount)[0]
    return {
      posture: 'retreat',
      title: `危险快跑 · ${threat.position}睡宽床`,
      summary: `${threat.position}已清${state.players[threat.playerId].dingque}并副露${threat.meldCount}组${threat.targetType}，公开牌型高度集中，疑似在做清一色或大牌。立即优先下叫、打缺；非必要不喂${threat.targetType}。`,
      signals: [`${threat.position}已副露${threat.meldCount}组${threat.targetType}`, `已清定缺${state.players[threat.playerId].dingque}`, `防守：慎打${threat.targetType}`],
      recommendedAction: null,
      source: '成都册第三章攻防、第四章清一色；公开副露危险信号',
    }
  }

  // 来源：知识库 3.3“为自摸创造条件”与 4.2 中残局取舍；仅提醒，不自动过胡。
  if (lowValueDiscardWin(state, playerId, opportunity)) {
    return {
      posture: 'press',
      title: '优势继续贪 · 素胡可缓',
      summary: `当前只是 1 分点炮，仍有 ${opportunity.total} 张自摸活张；牌墙还有 ${state.wall.length} 张，可考虑过牌等自摸。`,
      signals: [`${opportunity.structuralWaits.length} 种叫口`, `${opportunity.total} 张自摸活张`, '普通点炮，无附加番'],
      recommendedAction: 'pass',
      source: '知识库 3.3、4.2（自摸机会启发式）',
    }
  }

  const potential = pureSuitPotential(state, playerId)
  if (potential !== null) {
    // 来源：知识库 3.5 攻防与 4.3 清一色；连续三张是保守的公开牌竞争信号。
    const push = oppositeSuitPush(state, playerId, potential.type)
    if (push !== null) {
      return {
        posture: 'retreat',
        title: '劣势快跑 · 对家抢门',
        summary: `对家打过缺门后又连续推 ${push.count} 张${push.shedType}，疑似在收${potential.type}；清一色竞争加剧，立即转向先下叫。`,
        signals: [`你有 ${potential.count} 张${potential.type}`, `对家连续推${push.shedType}`, `两家目标门重叠`],
        recommendedAction: null,
        source: '成都册第二章第四节、第三章攻防、知识库 4.3',
      }
    }
  }

  const sameDingque = state.players.filter(candidate => !candidate.hasWon && candidate.dingque === player.dingque).length
  // 三家同缺本身已压缩剩余两门的进张空间；坐庄进一步放大速度风险，但不是必要条件。
  if (sameDingque >= 3) {
    return {
      posture: 'retreat',
      title: '劣势快跑 · 三家同缺',
      summary: `${sameDingque} 家都缺${player.dingque}，剩余两门竞争拥挤${state.dealer === playerId ? '，且你坐庄更怕被先和' : ''}；停止追大牌，优先打缺、下叫和止损。`,
      signals: [`${sameDingque} 家同缺${player.dingque}`, state.dealer === playerId ? '你是庄家' : '两门竞争拥挤', '先速度后番数'],
      recommendedAction: null,
      source: '成都册第一章开局节奏、知识库 4.4（同缺启发式）',
    }
  }

  // 来源：知识库 4.3 清一色与 4.4 定缺；两家缺目标门视为供牌优势，但仍需牌型集中。
  if (potential !== null && potential.feederCount >= 2) {
    return {
      posture: 'press',
      title: '优势继续贪 · 清一色窗口',
      summary: `${potential.feederCount} 家缺${potential.type}，你已有 ${potential.count} 张${potential.type}且副露未串色；暂未见强竞争，可继续观察清一色。`,
      signals: [`${potential.type}占有效结构 ${Math.round(potential.share * 100)}%`, `${potential.feederCount} 家会优先打${potential.type}`, '出现竞争信号立即转快胡'],
      recommendedAction: null,
      source: '成都册第四章番种秘籍、知识库 4.3、4.4',
    }
  }

  return {
    posture: 'steady',
    title: '先稳住',
    summary: '暂时没有足够强的快跑或做大信号；按机会数推进，继续观察同缺、连续舍牌与牌墙变化。',
    signals: [`你缺${player.dingque}`, `牌墙 ${state.wall.length} 张`, opportunity.total > 0 ? `${opportunity.total} 张活张` : '尚未形成有效叫口'],
    recommendedAction: null,
    source: '知识库 4.2 中残局打法（中性基线）',
  }
}
