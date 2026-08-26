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
  // 来源：成都册第一章成都麻将节奏与知识库 4.4；“坐庄且三家同缺”按用户需求作快胡启发式。
  if (state.dealer === playerId && sameDingque >= 3) {
    return {
      posture: 'retreat',
      title: '劣势快跑 · 同缺拥挤',
      summary: `${sameDingque} 家都缺${player.dingque}且你坐庄，剩余两门竞争拥挤；降低做大目标，优先打缺、下叫和止损。`,
      signals: [`${sameDingque} 家同缺${player.dingque}`, '你是庄家', '先速度后番数'],
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
