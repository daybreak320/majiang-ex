import type { Tile, TileType } from '../types'
import type { Meld } from './types'
import { MILESTONE_1_RULES } from './rules'

export type FanPatternId
  = | 'pingHu'
    | 'pengPengHu'
    | 'qingYiSe'
    | 'qiDui'
    | 'jinGouDiao'
    | 'longQiDui'
    | 'qingQiDui'
    | 'shuangLongQiDui'

export interface FanPattern {
  id: FanPatternId
  fan: number
}

export interface WinningOptions {
  melds?: readonly Meld[]
  dingque?: TileType | null
}

export interface ScoreOptions extends WinningOptions {
  specialFan?: number
}

export interface HandScore {
  patterns: FanPattern[]
  baseFan: number
  specialFan: number
  scoringFan: number
  points: number
}

type TileLike = Pick<Tile, 'type' | 'value'>

function tileIndex(tile: TileLike): number {
  return MILESTONE_1_RULES.tileTypes.indexOf(tile.type) * 9 + tile.value - 1
}

function tileCounts(tiles: readonly TileLike[]): number[] {
  const counts = Array.from({ length: 27 }, () => 0)
  for (const tile of tiles)
    counts[tileIndex(tile)]++
  return counts
}

function canFormMelds(counts: number[], groupsNeeded: number): boolean {
  if (groupsNeeded === 0)
    return counts.every(count => count === 0)

  const first = counts.findIndex(count => count > 0)
  if (first === -1)
    return false

  if (counts[first] >= 3) {
    counts[first] -= 3
    if (canFormMelds(counts, groupsNeeded - 1)) {
      counts[first] += 3
      return true
    }
    counts[first] += 3
  }

  const value = first % 9
  if (value <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0) {
    counts[first]--
    counts[first + 1]--
    counts[first + 2]--
    if (canFormMelds(counts, groupsNeeded - 1)) {
      counts[first]++
      counts[first + 1]++
      counts[first + 2]++
      return true
    }
    counts[first]++
    counts[first + 1]++
    counts[first + 2]++
  }

  return false
}

function canFormTriplets(counts: number[], groupsNeeded: number): boolean {
  if (groupsNeeded === 0)
    return counts.every(count => count === 0)

  const first = counts.findIndex(count => count > 0)
  if (first === -1 || counts[first] < 3)
    return false
  counts[first] -= 3
  const result = canFormTriplets(counts, groupsNeeded - 1)
  counts[first] += 3
  return result
}

function isStandardShape(tiles: readonly TileLike[], meldCount: number, tripletsOnly: boolean): boolean {
  const groupsNeeded = 4 - meldCount
  if (groupsNeeded < 0 || tiles.length !== groupsNeeded * 3 + 2)
    return false

  const counts = tileCounts(tiles)
  for (let index = 0; index < counts.length; index++) {
    if (counts[index] < 2)
      continue
    counts[index] -= 2
    const valid = tripletsOnly
      ? canFormTriplets(counts, groupsNeeded)
      : canFormMelds(counts, groupsNeeded)
    counts[index] += 2
    if (valid)
      return true
  }
  return false
}

export function getQiDuiLevel(tiles: readonly TileLike[], meldCount = 0): 0 | 1 | 2 | 3 {
  if (meldCount !== 0 || tiles.length !== 14)
    return 0
  const counts = tileCounts(tiles).filter(count => count > 0)
  if (counts.some(count => count !== 2 && count !== 4))
    return 0
  const pairCount = counts.reduce((total, count) => total + count / 2, 0)
  if (pairCount !== 7)
    return 0
  return Math.min(3, counts.filter(count => count === 4).length + 1) as 1 | 2 | 3
}

function allTiles(tiles: readonly TileLike[], melds: readonly Meld[]): TileLike[] {
  return [...tiles, ...melds.flatMap(meld => meld.tiles)]
}

function hasDingque(tiles: readonly TileLike[], melds: readonly Meld[], dingque: TileType | null | undefined): boolean {
  return dingque != null && allTiles(tiles, melds).some(tile => tile.type === dingque)
}

export function isWinningHand(tiles: readonly TileLike[], options: WinningOptions = {}): boolean {
  const melds = options.melds ?? []
  if (hasDingque(tiles, melds, options.dingque))
    return false
  return getQiDuiLevel(tiles, melds.length) > 0 || isStandardShape(tiles, melds.length, false)
}

function isQingYiSe(tiles: readonly TileLike[], melds: readonly Meld[]): boolean {
  return new Set(allTiles(tiles, melds).map(tile => tile.type)).size === 1
}

function isPengPengHu(tiles: readonly TileLike[], melds: readonly Meld[]): boolean {
  if (melds.some(meld => !['peng', 'mingGang', 'buGang', 'anGang'].includes(meld.kind)))
    return false
  return isStandardShape(tiles, melds.length, true)
}

export function identifyFanPatterns(tiles: readonly TileLike[], options: WinningOptions = {}): FanPattern[] {
  const melds = options.melds ?? []
  if (!isWinningHand(tiles, options))
    return []

  const patterns: FanPattern[] = []
  const qiDuiLevel = getQiDuiLevel(tiles, melds.length)
  const qingYiSe = isQingYiSe(tiles, melds)

  if (qiDuiLevel > 0) {
    if (qingYiSe) {
      patterns.push({ id: 'qingQiDui', fan: 4 })
    }
    else if (qiDuiLevel >= 3) {
      patterns.push({ id: 'shuangLongQiDui', fan: 4 })
    }
    else if (qiDuiLevel === 2) {
      patterns.push({ id: 'longQiDui', fan: 3 })
    }
    else {
      patterns.push({ id: 'qiDui', fan: 2 })
    }
    return patterns
  }

  const pengPengHu = isPengPengHu(tiles, melds)
  if (pengPengHu)
    patterns.push({ id: 'pengPengHu', fan: 1 })
  if (qingYiSe)
    patterns.push({ id: 'qingYiSe', fan: 2 })
  if (melds.length === 4 && tiles.length === 2)
    patterns.push({ id: 'jinGouDiao', fan: 2 })
  if (patterns.length === 0)
    patterns.push({ id: 'pingHu', fan: 0 })
  return patterns
}

export function calculateScore(tiles: readonly TileLike[], options: ScoreOptions = {}): HandScore | null {
  const patterns = identifyFanPatterns(tiles, options)
  if (patterns.length === 0)
    return null
  const baseFan = patterns.reduce((total, pattern) => total + pattern.fan, 0)
  const specialFan = Math.max(0, options.specialFan ?? 0)
  const scoringFan = Math.min(MILESTONE_1_RULES.fanCap, baseFan + specialFan)
  return {
    patterns,
    baseFan,
    specialFan,
    scoringFan,
    points: MILESTONE_1_RULES.baseScore * 2 ** scoringFan,
  }
}
