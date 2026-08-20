import type { TileType } from '../types'
import type { AIStyle, GameState, PlayerId, PlayerState, TileInstance } from './types'
import { MILESTONE_1_RULES } from './rules'

export interface SeededRandom {
  next: () => number
  nextInt: (maximum: number) => number
}

export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    nextInt: maximum => Math.floor(next() * maximum),
  }
}

export function createTileSet(): TileInstance[] {
  const tiles: TileInstance[] = []
  for (const type of MILESTONE_1_RULES.tileTypes) {
    for (const value of MILESTONE_1_RULES.values) {
      for (let copy = 0; copy < MILESTONE_1_RULES.copiesPerTile; copy++)
        tiles.push({ id: `${type}-${value}-${copy}`, type, value })
    }
  }
  return tiles
}

export function shuffleTiles(tiles: readonly TileInstance[], random: SeededRandom): TileInstance[] {
  const shuffled = [...tiles]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = random.nextInt(index + 1)
    const tile = shuffled[index]
    shuffled[index] = shuffled[target]
    shuffled[target] = tile
  }
  return shuffled
}

export function compareTiles(a: Pick<TileInstance, 'type' | 'value'>, b: Pick<TileInstance, 'type' | 'value'>): number {
  const typeDifference = MILESTONE_1_RULES.tileTypes.indexOf(a.type) - MILESTONE_1_RULES.tileTypes.indexOf(b.type)
  return typeDifference || a.value - b.value
}

export function sortTiles(tiles: readonly TileInstance[]): TileInstance[] {
  return [...tiles].sort(compareTiles)
}

function createPlayer(id: PlayerId, aiStyle: AIStyle | null): PlayerState {
  return {
    id,
    hand: [],
    discards: [],
    melds: [],
    score: 0,
    dingque: null,
    hasWon: false,
    winInfo: null,
    passedWinValue: null,
    aiStyle,
  }
}

export function createInitialGame(seed: number): GameState {
  const random = createSeededRandom(seed)
  const dealer = random.nextInt(4) as PlayerId
  const styles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null),
    createPlayer(1, styles[0]),
    createPlayer(2, styles[1]),
    createPlayer(3, styles[2]),
  ]
  const wall = shuffleTiles(createTileSet(), random)

  for (let round = 0; round < 13; round++) {
    for (const player of players)
      player.hand.push(wall.pop()!)
  }
  players[dealer].hand.push(wall.pop()!)
  for (const player of players)
    player.hand = sortTiles(player.hand)

  return {
    rulesVersion: MILESTONE_1_RULES.version,
    seed,
    phase: 'dingque',
    players,
    wall,
    dealer,
    currentPlayer: dealer,
    lastDrawnTileId: null,
    lastDrawWasReplacement: false,
    lastDrawWasLastTile: false,
    responseWindow: null,
    kongContext: null,
    endReason: null,
    nextEventSequence: 1,
    events: [],
  }
}

function shuffleValues<T>(values: readonly T[], random: SeededRandom): T[] {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = random.nextInt(index + 1)
    const value = shuffled[index]
    shuffled[index] = shuffled[target]
    shuffled[target] = value
  }
  return shuffled
}

interface SuitStructure {
  count: number
  pairs: number
  adjacentPairs: number
  gapPairs: number
  isolated: number
}

function analyzeSuit(tiles: readonly TileInstance[], type: TileType): SuitStructure {
  const counts = Array.from({ length: 10 }, () => 0)
  for (const tile of tiles) {
    if (tile.type === type)
      counts[tile.value]++
  }

  let count = 0
  let pairs = 0
  let adjacentPairs = 0
  let gapPairs = 0
  let isolated = 0
  for (let value = 1; value <= 9; value++) {
    count += counts[value]
    pairs += Math.floor(counts[value] / 2)
    if (value < 9 && counts[value] > 0 && counts[value + 1] > 0)
      adjacentPairs++
    if (value < 8 && counts[value] > 0 && counts[value + 2] > 0)
      gapPairs++
    if (counts[value] > 0 && ![value - 2, value - 1, value + 1, value + 2].some(nearby => counts[nearby] > 0))
      isolated += counts[value]
  }
  return { count, pairs, adjacentPairs, gapPairs, isolated }
}

function suitRemovalLoss(tiles: readonly TileInstance[], type: TileType): number {
  const structure = analyzeSuit(tiles, type)
  return structure.count * 4
    + structure.pairs * 3
    + structure.adjacentPairs * 2
    + structure.gapPairs
    - structure.isolated
}

export function recommendDingque(tiles: readonly TileInstance[]): TileType {
  return [...MILESTONE_1_RULES.tileTypes].sort((a, b) =>
    suitRemovalLoss(tiles, a) - suitRemovalLoss(tiles, b)
    || MILESTONE_1_RULES.tileTypes.indexOf(a) - MILESTONE_1_RULES.tileTypes.indexOf(b),
  )[0]
}

export function getLegalDiscards(hand: readonly TileInstance[], dingque: TileType | null): TileInstance[] {
  const dingqueTiles = dingque === null ? [] : hand.filter(tile => tile.type === dingque)
  return sortTiles(dingqueTiles.length > 0 ? dingqueTiles : hand)
}

function handEfficiency(tiles: readonly TileInstance[]): number {
  return MILESTONE_1_RULES.tileTypes.reduce((score, type) => {
    const structure = analyzeSuit(tiles, type)
    return score
      + structure.pairs * 5
      + structure.adjacentPairs * 3
      + structure.gapPairs * 2
      - structure.isolated
  }, 0)
}

export function chooseTimeoutDiscard(
  hand: readonly TileInstance[],
  dingque: TileType | null,
  lastDrawnTileId: string | null,
): TileInstance | null {
  const legal = getLegalDiscards(hand, dingque)
  if (legal.length === 0)
    return null

  const drawnTile = legal.find(tile => tile.id === lastDrawnTileId)
  if (drawnTile)
    return drawnTile

  return [...legal].sort((a, b) => {
    const afterA = hand.filter(tile => tile.id !== a.id)
    const afterB = hand.filter(tile => tile.id !== b.id)
    return handEfficiency(afterB) - handEfficiency(afterA) || compareTiles(a, b)
  })[0]
}
