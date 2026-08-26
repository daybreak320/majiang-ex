import type { Tile } from '../types'
import type { GameCommand, GameState, PlayerId, TileInstance } from './types'
import { brokenStrongCombos, countOpportunities, rateOpportunity } from '../knowledge/mahjongTheory'
import { chooseAICommand, getAIReason } from './ai'
import { MILESTONE_1_RULES } from './rules'

export interface AssistantWait {
  tile: Tile
  remaining: number
  probability: number
}

export interface KnownTileCount {
  tile: Tile
  count: number
}

export interface DiscardAssistantAnalysis {
  recommendation: GameCommand | null
  recommendationLabel: string
  reason: string
  knownTiles: number
  unknownTiles: number
  wallTiles: number
  knownTileCounts: KnownTileCount[]
  opportunity: number
  structuralWaits: number
  nextDrawWinProbability: number | null
  waits: AssistantWait[]
}

const OPPORTUNITY_RATING_LABEL: Record<ReturnType<typeof rateOpportunity>, string> = {
  poor: '较少',
  fair: '一般',
  good: '良好',
  excellent: '充足',
}

function sameTile(a: Tile, b: Tile): boolean {
  return a.type === b.type && a.value === b.value
}

function publicTiles(state: GameState): TileInstance[] {
  return state.players.flatMap(player => [
    ...player.discards,
    ...player.melds.flatMap(meld => meld.tiles),
    ...(player.hasWon ? player.hand : []),
  ])
}

function knownTiles(state: GameState, playerId: PlayerId): TileInstance[] {
  const unique = new Map<string, TileInstance>()
  for (const tile of [...state.players[playerId].hand, ...publicTiles(state)])
    unique.set(tile.id, tile)
  return [...unique.values()]
}

function commandLabel(command: GameCommand | null, state: GameState): string {
  if (command === null)
    return '等待行动'
  if (command.type === 'dingque')
    return `定缺${command.tileType}`
  if (command.type === 'discard') {
    const tile = state.players[command.playerId].hand.find(candidate => candidate.id === command.tileId)
    return tile === undefined ? '出牌' : `打 ${tile.value}${tile.type}`
  }
  if (command.type === 'hu')
    return state.phase === 'responding' ? '胡牌' : '自摸胡'
  if (command.type === 'peng')
    return '碰'
  if (command.type === 'gang')
    return command.kind === 'anGang' ? '暗杠' : command.kind === 'buGang' ? '补杠' : '明杠'
  return '过'
}

function tileCounts(tiles: readonly TileInstance[]): KnownTileCount[] {
  return MILESTONE_1_RULES.tileTypes.flatMap(type => MILESTONE_1_RULES.values.map(value => ({
    tile: { type, value },
    count: tiles.filter(candidate => candidate.type === type && candidate.value === value).length,
  })))
}

/**
 * 基于玩家可见信息生成实时辅助。
 * 概率口径：有效叫口剩余张数 / 全部未知牌，表示下一张牌直接胡牌的条件概率。
 * 来源：理论册第一、二节及成都册第二章第一节的机会数计算方法。
 */
export function buildDiscardAssistant(state: GameState, playerId: PlayerId = 0): DiscardAssistantAnalysis {
  const player = state.players[playerId]
  const visible = publicTiles(state)
  const known = knownTiles(state, playerId)
  const totalTileCount = MILESTONE_1_RULES.tileTypes.length
    * MILESTONE_1_RULES.values.length
    * MILESTONE_1_RULES.copiesPerTile
  const unknownTiles = Math.max(0, totalTileCount - known.length)
  const recommendation = chooseAICommand(state, playerId)

  let opportunity = countOpportunities(player.hand, visible, {
    dingque: player.dingque,
    melds: player.melds,
  })
  let reason = recommendation === null
    ? '当前不是你的决策窗口，概率按现有手牌和公开信息持续更新。'
    : getAIReason(state, playerId, recommendation)

  if (recommendation?.type === 'discard') {
    const discarded = player.hand.find(tile => tile.id === recommendation.tileId)
    if (discarded !== undefined) {
      const handAfter = player.hand.filter(tile => tile.id !== discarded.id)
      opportunity = countOpportunities(handAfter, [...visible, discarded], {
        dingque: player.dingque,
        melds: player.melds,
      })
      const broken = brokenStrongCombos(player.hand, discarded)
      const waitSummary = opportunity.structuralWaits.length === 0
        ? '打后尚未下叫'
        : `打后有 ${opportunity.structuralWaits.length} 种结构叫口、${opportunity.total} 张活张`
      const comboSummary = broken.length === 0
        ? '未拆强组合'
        : `会拆 ${broken.map(([a, b]) => `${a}-${b}`).join('、')} 强组合`
      reason = `${waitSummary}，机会质量${OPPORTUNITY_RATING_LABEL[rateOpportunity(opportunity.total)]}；${comboSummary}。`
    }
  }

  const waits = opportunity.structuralWaits.map(wait => ({
    ...wait,
    probability: unknownTiles === 0 ? 0 : wait.remaining / unknownTiles,
  }))
  const nextDrawWinProbability = player.hasWon
    ? 1
    : opportunity.structuralWaits.length === 0
      ? null
      : unknownTiles === 0
        ? 0
        : Math.min(1, opportunity.total / unknownTiles)

  return {
    recommendation,
    recommendationLabel: commandLabel(recommendation, state),
    reason,
    knownTiles: known.length,
    unknownTiles,
    wallTiles: state.wall.length,
    knownTileCounts: tileCounts(known).filter(item => item.count > 0),
    opportunity: opportunity.total,
    structuralWaits: opportunity.structuralWaits.length,
    nextDrawWinProbability,
    waits,
  }
}

export function countKnownCopies(analysis: DiscardAssistantAnalysis, tile: Tile): number {
  return analysis.knownTileCounts.find(item => sameTile(item.tile, tile))?.count ?? 0
}
