import type { TileType } from '../types'

export type PlayerId = 0 | 1 | 2 | 3
export type RulesVersion = 'm1.1'
export type AIStyle = 'aggressive' | 'steady' | 'efficient' | 'qingyise' | 'turtle' | 'pengManiac'

export interface OpponentConfig {
  name: string
  aiStyle: AIStyle
}

export interface TileInstance {
  id: string
  type: TileType
  value: number
}

export type MeldKind = 'peng' | 'mingGang' | 'buGang' | 'anGang'

export interface Meld {
  kind: MeldKind
  tiles: TileInstance[]
  fromPlayer: PlayerId | null
}

export type GamePhase = 'dingque' | 'discarding' | 'responding' | 'finished'
export type EndReason = 'three_winners' | 'wall_empty'
export type WinKind = 'selfDraw' | 'discard' | 'robKong'
export type SpecialWinKind = 'selfDraw' | 'kongDraw' | 'kongDiscard' | 'robKong' | 'lastTileDraw' | 'lastTileDiscard'

export interface WinInfo {
  tile: TileInstance
  fromPlayer: PlayerId | null
  kind: WinKind
  fan: number
  points: number
  special: SpecialWinKind[]
}

export interface PlayerState {
  id: PlayerId
  hand: TileInstance[]
  discards: TileInstance[]
  melds: Meld[]
  score: number
  dingque: TileType | null
  hasWon: boolean
  winInfo: WinInfo | null
  passedWinValue: number | null
  aiStyle: AIStyle | null
  displayName?: string
}

export type ResponseChoice
  = | { type: 'hu', value: number }
    | { type: 'peng' }
    | { type: 'gang' }
    | { type: 'pass' }

export interface ResponseWindow {
  kind: 'discard' | 'buGang'
  sourcePlayer: PlayerId
  tile: TileInstance
  eligiblePlayers: PlayerId[]
  choices: Partial<Record<PlayerId, ResponseChoice>>
  resumePlayer: PlayerId
  pendingMeldIndex: number | null
  sourceEventSequence: number
  isLastTile: boolean
  isKongDiscard: boolean
}

export interface KongContext {
  playerId: PlayerId
  gained: number
  kongEventSequence: number
  awaitingDiscard: boolean
}

export type ScoreReason = 'self_draw' | 'discard_win' | 'kong' | 'call_transfer' | 'kong_refund' | 'flower_pig' | 'ready_compensation'

export type GameStateSnapshot = Omit<GameState, 'events' | 'nextEventSequence'>

type SequencedEvent<Event> = Event & { sequence: number, state?: GameStateSnapshot }

export type GameEvent = SequencedEvent<
  | { type: 'dingque_selected', playerId: PlayerId, tileType: TileType }
  | { type: 'tile_drawn', playerId: PlayerId, tile: TileInstance, replacement: boolean, lastTile: boolean }
  | { type: 'tile_discarded', playerId: PlayerId, tile: TileInstance }
  | { type: 'response_opened', window: ResponseWindow }
  | { type: 'response_chosen', playerId: PlayerId, choice: ResponseChoice }
  | { type: 'response_settled', outcome: 'none' | 'peng' | 'gang' | 'hu' | 'robbedKong', actors: PlayerId[] }
  | { type: 'meld_declared', playerId: PlayerId, meld: Meld, replacedMeldIndex: number | null }
  | { type: 'player_won', playerId: PlayerId, info: WinInfo }
  | { type: 'passed_win_set', playerId: PlayerId, value: number | null }
  | { type: 'score_transferred', from: PlayerId, to: PlayerId, amount: number, reason: ScoreReason, sourceEventSequence: number }
  | { type: 'turn_changed', playerId: PlayerId, lastDrawnTileId: string | null }
  | { type: 'final_settlement_started' }
  | { type: 'final_settlement_completed' }
  | { type: 'game_finished', reason: EndReason }
>

export interface GameState {
  rulesVersion: RulesVersion
  seed: number
  phase: GamePhase
  players: [PlayerState, PlayerState, PlayerState, PlayerState]
  wall: TileInstance[]
  dealer: PlayerId
  currentPlayer: PlayerId
  lastDrawnTileId: string | null
  lastDrawWasReplacement: boolean
  lastDrawWasLastTile: boolean
  responseWindow: ResponseWindow | null
  kongContext: KongContext | null
  endReason: EndReason | null
  nextEventSequence: number
  events: GameEvent[]
}

export type LegalAction
  = | { type: 'dingque', tileType: TileType }
    | { type: 'discard', tileId: string }
    | { type: 'hu', tileId: string, value: number }
    | { type: 'peng', tileId: string }
    | { type: 'gang', tileId: string, kind: 'mingGang' | 'buGang' | 'anGang' }
    | { type: 'pass' }

export type GameCommand = LegalAction & { playerId: PlayerId }

export type CommandResult
  = | { ok: true, nextState: GameState, events: GameEvent[] }
    | { ok: false, state: GameState, error: string, events: [] }
