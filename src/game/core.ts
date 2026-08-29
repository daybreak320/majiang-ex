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

export type SpecialTrainingKind = 'attack-qingyise' | 'attack-jingoudiao' | 'defense-big-hands' | 'defense-race-qingyise' | 'endgame-count'

export const SPECIAL_TRAINING_META: Record<SpecialTrainingKind, { title: string, summary: string }> = {
  'attack-qingyise': { title: '进攻 · 睡宽床清一色', summary: '起手给出单门集中结构，练习何时副露抢速度、何时保留宽叫。' },
  'attack-jingoudiao': { title: '进攻 · 金钩钓与杠开', summary: '给出对子与刻子密集牌型，练习收口、补杠与杠开风险。' },
  'defense-big-hands': { title: '防守 · 三家做大', summary: '三家公开结构快速推进，练习不喂牌、降速与止损。' },
  'defense-race-qingyise': { title: '攻防 · 争做清一色', summary: '你与对手同门集中，练习抢速度或果断转防。' },
  'endgame-count': { title: '残局 · 最后十张算牌', summary: '牌墙压到十张，公开牌密集，练习精确扣张、叫口与安全牌。' },
}

function takeSpecifiedTiles(pool: TileInstance[], specification: string): TileInstance[] {
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map((character) => {
      const index = pool.findIndex(tile => tile.type === type && tile.value === Number(character))
      if (index < 0)
        throw new Error(`专项训练牌池不足：${character}${type}`)
      return pool.splice(index, 1)[0]
    })
  })
}

function dealTrainingHand(pool: TileInstance[], specification: string): TileInstance[] {
  return sortTiles(takeSpecifiedTiles(pool, specification))
}

/** 专项训练的河牌是明确的公开证据；不再用随机剩余牌填充剧情。 */
function dealTrainingRiver(pool: TileInstance[], specification: string): TileInstance[] {
  return sortTiles(takeSpecifiedTiles(pool, specification))
}

/** 残局保留牌墙也写死，保证每次练到的是同一套“已知牌河 + 十张未知牌”。 */
function dealTrainingWall(pool: TileInstance[], specification: string): TileInstance[] {
  return takeSpecifiedTiles(pool, specification)
}

function setTrainingMeld(player: PlayerState, pool: TileInstance[], kind: 'peng', specification: string, fromPlayer: PlayerId): void {
  player.melds = [{ kind, tiles: takeSpecifiedTiles(pool, specification), fromPlayer }]
}

export function createSpecialTrainingGame(seed: number, kind: SpecialTrainingKind): GameState {
  const random = createSeededRandom(seed)
  const pool = shuffleTiles(createTileSet(), random)
  const styles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null), createPlayer(1, styles[0]), createPlayer(2, styles[1]), createPlayer(3, styles[2]),
  ]
  const hands: Record<SpecialTrainingKind, [string, string, string, string]> = {
    // 起手必须是可教学的单门胚子，而非清七对等已成和牌；专项练的是取舍，不是点一下领奖。
    'attack-qingyise': ['11234567894569条', '123456789万 1234筒', '123456789筒 1234万', '123456789万 5678筒'],
    // 刻子密集但留有远张散搭：练习收口/杠取舍，绝不能以已完成牌型开局。
    'attack-jingoudiao': ['11122233344589万', '123456789条 1234筒', '123456789筒 1234条', '123456789条 5678筒'],
    'defense-big-hands': ['123456789万 34567条', '1112223334条', '1112223334445筒', '1112223334445万'],
    // 同样避开清七对成牌；对手用公开 888条表露目标门，其余暗手不越过牌池上限。
    'defense-race-qingyise': ['11234567894569条', '222条 1234567万', '123456789筒 1234万', '56789万 12345678筒'],

    'endgame-count': ['123456789万 34567条', '1122334455667筒', '1112223334445万', '123456789条 5678筒'],
  }
  for (const [index, hand] of hands[kind].entries())
    players[index as PlayerId].hand = dealTrainingHand(pool, hand)
  for (const player of players)
    player.dingque = recommendDingque(player.hand)
  if (kind === 'attack-qingyise') {
    // 两家持续打万，给你“条门供牌”的公开窗口；自己则需要比较副露抢跑与保留宽叫。
    players[1].discards = dealTrainingRiver(pool, '56789万')
    players[2].discards = dealTrainingRiver(pool, '56789万')
    players[3].discards = dealTrainingRiver(pool, '234条')
  }
  if (kind === 'attack-jingoudiao') {
    // 河里已有多张万中张：刻子密集并不意味着盲目追杠，必须按剩余张与牌墙作取舍。
    players[1].discards = dealTrainingRiver(pool, '456789万')
    players[2].discards = dealTrainingRiver(pool, '56789万')
    players[3].discards = dealTrainingRiver(pool, '123筒')
  }
  if (kind === 'defense-big-hands' || kind === 'defense-race-qingyise') {
    setTrainingMeld(players[1], pool, 'peng', kind === 'defense-big-hands' ? '777条' : '888条', 2)
    if (kind === 'defense-big-hands') {
      // 三家分别公开向条/筒/万推进，训练目标是止损与找现物，不是猜暗牌。
      players[1].discards = dealTrainingRiver(pool, '45689条')
      players[2].discards = dealTrainingRiver(pool, '6789筒')
      players[3].discards = dealTrainingRiver(pool, '56789万')
    }
    else {
      // 对家已碰条且河里连续弃万：这是可见的同门竞速证据，迫使你比较抢门与转防。
      players[1].discards = dealTrainingRiver(pool, '45689万')
      players[2].discards = dealTrainingRiver(pool, '5678筒')
      players[3].discards = dealTrainingRiver(pool, '1234万')
    }
  }
  if (kind === 'endgame-count') {
    // 固定十张残局墙：用已知牌河扣张，而不是把随机余牌伪装成一道残局题。
    const wall = dealTrainingWall(pool, '123456789条 9筒')
    const revealed = sortTiles(pool.splice(0))
    players[1].discards = revealed.slice(0, Math.ceil(revealed.length / 3))
    players[2].discards = revealed.slice(Math.ceil(revealed.length / 3), Math.ceil(revealed.length * 2 / 3))
    players[3].discards = revealed.slice(Math.ceil(revealed.length * 2 / 3))
    pool.push(...wall)
  }
  return {
    rulesVersion: MILESTONE_1_RULES.version, seed, phase: 'discarding', players, wall: pool, dealer: 0, currentPlayer: 0,
    lastDrawnTileId: players[0].hand[players[0].hand.length - 1]?.id ?? null, lastDrawWasReplacement: false, lastDrawWasLastTile: false,
    responseWindow: null, kongContext: null, endReason: null, nextEventSequence: 1, events: [],
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
