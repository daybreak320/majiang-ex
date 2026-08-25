import type { HandScore } from './scoring'
import type { GameEvent, GameState, PlayerId, PlayerState, ScoreReason, TileInstance } from './types'
import { MILESTONE_1_RULES } from './rules'
import { calculateScore } from './scoring'

export interface ReadyTile {
  tile: Pick<TileInstance, 'type' | 'value'>
  score: HandScore
}

export interface ReadyHandAnalysis {
  isReady: boolean
  tiles: ReadyTile[]
  highestPoints: number
}

export interface SettlementTransfer {
  from: PlayerId
  to: PlayerId
  amount: number
  reason: Extract<ScoreReason, 'kong_refund' | 'flower_pig' | 'ready_compensation'>
  sourceEventSequence: number
}

export interface FinalSettlement {
  refunds: SettlementTransfer[]
  flowerPigPayments: SettlementTransfer[]
  readyPayments: SettlementTransfer[]
}

function playerTileCount(player: PlayerState, type: TileInstance['type'], value: number): number {
  return player.hand.filter(tile => tile.type === type && tile.value === value).length
    + player.melds.flatMap(meld => meld.tiles).filter(tile => tile.type === type && tile.value === value).length
}

export function isFlowerPig(player: PlayerState): boolean {
  return player.dingque !== null
    && [...player.hand, ...player.melds.flatMap(meld => meld.tiles)].some(tile => tile.type === player.dingque)
}

export function analyzeReadyHand(player: PlayerState): ReadyHandAnalysis {
  if (isFlowerPig(player))
    return { isReady: false, tiles: [], highestPoints: 0 }

  const tiles: ReadyTile[] = []
  for (const type of MILESTONE_1_RULES.tileTypes) {
    for (const value of MILESTONE_1_RULES.values) {
      if (playerTileCount(player, type, value) >= MILESTONE_1_RULES.copiesPerTile)
        continue
      const score = calculateScore([...player.hand, { type, value }], {
        melds: player.melds,
        dingque: player.dingque,
      })
      if (score !== null)
        tiles.push({ tile: { type, value }, score })
    }
  }
  return {
    isReady: tiles.length > 0,
    tiles,
    highestPoints: tiles.reduce((highest, tile) => Math.max(highest, tile.score.points), 0),
  }
}

function originalKongTransfers(state: GameState): Extract<GameEvent, { type: 'score_transferred' }>[] {
  return state.events.filter((event): event is Extract<GameEvent, { type: 'score_transferred' }> =>
    event.type === 'score_transferred' && event.reason === 'kong',
  )
}

export function settleFinal(state: GameState, sourceEventSequence: number): FinalSettlement {
  if (state.events.some(event => event.type === 'final_settlement_completed'))
    return { refunds: [], flowerPigPayments: [], readyPayments: [] }

  const active = state.players.filter(player => !player.hasWon)
  const activeIds = new Set(active.map(player => player.id))
  const flowerPigs = new Set(active.filter(isFlowerPig).map(player => player.id))
  const ready = new Map(active.map(player => [player.id, analyzeReadyHand(player)]))
  const notReady = new Set(active.filter(player => !ready.get(player.id)!.isReady).map(player => player.id))

  const refunds = originalKongTransfers(state)
    .filter(event => notReady.has(event.to) && activeIds.has(event.from))
    .map(event => ({
      from: event.to,
      to: event.from,
      amount: event.amount,
      reason: 'kong_refund' as const,
      sourceEventSequence: event.sequence,
    }))

  const flowerPigPoints = MILESTONE_1_RULES.baseScore * 2 ** MILESTONE_1_RULES.fanCap
  const flowerPigPayments = active
    .filter(player => flowerPigs.has(player.id))
    .flatMap(from => active
      .filter(to => to.id !== from.id && !flowerPigs.has(to.id))
      .map(to => ({
        from: from.id,
        to: to.id,
        amount: flowerPigPoints,
        reason: 'flower_pig' as const,
        sourceEventSequence,
      })))

  const readyPlayers = active.filter(player => !flowerPigs.has(player.id) && ready.get(player.id)!.isReady)
  const readyPayments = active
    .filter(player => notReady.has(player.id))
    .flatMap(from => readyPlayers
      .filter(to => to.id !== from.id)
      .map(to => ({
        from: from.id,
        to: to.id,
        amount: ready.get(to.id)!.highestPoints,
        reason: 'ready_compensation' as const,
        sourceEventSequence,
      })))

  return { refunds, flowerPigPayments, readyPayments }
}
