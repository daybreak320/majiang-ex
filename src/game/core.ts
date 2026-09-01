import type { TileType } from '../types'
import type { AIStyle, GameState, OpponentConfig, PlayerId, PlayerState, TileInstance } from './types'
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

function createPlayer(id: PlayerId, aiStyle: AIStyle | null, displayName?: string): PlayerState {
  return {
    id,
    displayName,
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

export type SpecialTrainingKind = 'attack-qingyise' | 'attack-jingoudiao' | 'defense-big-hands' | 'defense-race-qingyise' | 'endgame-count' | 'endgame-qingyise-tenpai'

/** 最后十张专用题库：500 局内每局编号对应一张确定且不同的残局。 */
export const ENDGAME_COUNT_LIBRARY_SIZE = 500
const ENDGAME_COUNT_LIBRARY_SEED = 0x5EED1000

/** 下宽叫专项采用独立的百局题库，而非少量模板的花色换皮。 */
export const WIDE_TENPAI_LIBRARY_SIZE = 100
const WIDE_TENPAI_LIBRARY_SEED = 0x71E0A110

/** 金钩钓按编号生成百局独立的公开扣张残局。 */
export const JINGOUDIAO_LIBRARY_SIZE = 100
const JINGOUDIAO_LIBRARY_SEED = 0x4A1C0DE0

function getLibrarySeed(index: number, librarySize: number, baseSeed: number): number {
  const normalized = ((index % librarySize) + librarySize) % librarySize
  return (baseSeed + Math.imul(normalized + 1, 104729)) >>> 0
}

export function getEndgameCountLibrarySeed(index: number): number {
  return getLibrarySeed(index, ENDGAME_COUNT_LIBRARY_SIZE, ENDGAME_COUNT_LIBRARY_SEED)
}

export function getWideTenpaiLibrarySeed(index: number): number {
  return getLibrarySeed(index, WIDE_TENPAI_LIBRARY_SIZE, WIDE_TENPAI_LIBRARY_SEED)
}

export function getJingoudiaoLibrarySeed(index: number): number {
  return getLibrarySeed(index, JINGOUDIAO_LIBRARY_SIZE, JINGOUDIAO_LIBRARY_SEED)
}

export interface WideTenpaiScenario {
  title: string
  goal: string
  kind: 'qingyise' | 'kongDraw' | 'twoSuits'
  /** 每一题都明确写出起手与十张未知墙，不能靠花色镜像充当新题。 */
  hand?: string
  wall?: string
}

/**
 * 下宽叫题库。每条记录都是独立的手牌、公开扣张与十张未知墙组合；
 * 同类题不以换花色或点数镜像计数。
 */
const WIDE_TENPAI_SCENARIOS: readonly WideTenpaiScenario[] = [
  { title: '清一色残局 · 连张宽叫', goal: '同样一打即叫，比较谁留下的叫口更多、活张更宽。', kind: 'qingyise', hand: '11223344556789万', wall: '124579万 1234条' },
  { title: '杠开残局 · 双单吊比较', goal: '杠后补张不等于盲冲；比较留下哪张单吊牌，才有更多真正活张。', kind: 'kongDraw', hand: '59筒', wall: '55筒 12345678条' },
  { title: '两门交界 · 宽叫取舍', goal: '两条边张都能下叫时，别只看番型；先按公开扣张核对真正活牌。', kind: 'twoSuits', hand: '123456789万 5678条', wall: '124579万 1234条' },
  { title: '清一色残局 · 对子与顺子', goal: '对子能保留不等于叫口更宽；先逐张扣掉公开牌，再比较实际活张。', kind: 'qingyise', hand: '11223344556678万', wall: '123579万 5678条' },
  { title: '清一色残局 · 中张收口', goal: '中张看起来顺眼，也可能被公开河压死；选还真正活着的听口。', kind: 'qingyise', hand: '22334455667789万', wall: '124568万 1234条' },
  { title: '两门交界 · 边张转两面', goal: '两门都有可弃张时，比较两条路线的后续接续，不要只盯一门牌型。', kind: 'twoSuits', hand: '23456789万 345678条', wall: '123579万 1234筒' },
  { title: '杠开残局 · 公开扣张', goal: '四副暗杠后只剩两张候选；墙里留了什么、河里死了什么，决定该钓哪张。', kind: 'kongDraw', hand: '28筒', wall: '55筒 12345678条' },
  { title: '两门交界 · 安全退路', goal: '下叫之外还要看退路：当活张接近时，优先保留公开牌更少的一边。', kind: 'twoSuits', hand: '3456789万 3456789条', wall: '124689万 1234筒' },
  { title: '清一色残局 · 高张陷阱', goal: '高张连张未必更宽；用牌河扣张验证 7、8、9 的真实存量。', kind: 'qingyise', hand: '12334455677889万', wall: '124568万 2345条' },
]

export function getWideTenpaiScenario(seed: number): WideTenpaiScenario {
  return WIDE_TENPAI_SCENARIOS[Math.abs(seed) % WIDE_TENPAI_SCENARIOS.length]
}

/** 每个专项可轮换的题组数；入口据此保证连续进入不重复。 */
export function getSpecialTrainingScenarioCount(kind: SpecialTrainingKind): number {
  if (kind === 'attack-qingyise')
    return WIDE_BED_SCENARIOS.length
  if (kind === 'endgame-qingyise-tenpai')
    return WIDE_TENPAI_LIBRARY_SIZE
  if (kind === 'endgame-count')
    return ENDGAME_COUNT_LIBRARY_SIZE
  if (kind === 'attack-jingoudiao')
    return JINGOUDIAO_LIBRARY_SIZE
  return 3
}

export const SPECIAL_TRAINING_META: Record<SpecialTrainingKind, { title: string, summary: string }> = {
  'attack-qingyise': { title: '进攻 · 三家缺万宽床决策', summary: '从三家对手都清完万门的第一巡起步；你持万门宽床，按手牌基础、后续上牌与对手推进，选择清一色、七对自摸、普通自摸或素胡兑现。' },
  'endgame-qingyise-tenpai': { title: '残局 · 下宽叫', summary: '清一色与杠开两类残局轮换出现；同样能下叫时，练习选出叫口更多、活张更宽的一打。' },
  'attack-jingoudiao': { title: '残局 · 金钩钓换听', summary: '四副碰牌已成，摸进两张候选后只留一张单吊；每次换听都比较真正还活的牌，直到胡牌。' },
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

function dealTrainingHandWithoutSuit(pool: TileInstance[], forbidden: TileType, count: number): TileInstance[] {
  const hand: TileInstance[] = []
  while (hand.length < count) {
    const index = pool.findIndex(tile => tile.type !== forbidden)
    if (index < 0)
      throw new Error(`专项训练牌池不足：无法凑出 ${count} 张非${forbidden}手牌`)
    hand.push(pool.splice(index, 1)[0])
  }
  return sortTiles(hand)
}

export interface WideBedScenario {
  id: 'qingyise-window' | 'qiduizi-window' | 'ordinary-selfdraw' | 'cash-out' | 'late-push' | 'defensive-convert'
  title: string
  startingHand: string
  teachingGoal: string
  route: '清一色' | '七对自摸' | '普通自摸' | '素胡走人'
  condition: string
  nextDraws: string
}

const WIDE_BED_SCENARIOS: readonly WideBedScenario[] = [
  {
    id: 'qingyise-window', title: '万门集中 · 上牌顺', startingHand: '112345567899万 15筒', route: '清一色',
    condition: '三家对手缺万；你有 11 张万子且搭子连贯，万门成为宽床，牌墙前段仍够长。',
    teachingGoal: '观察万子是否连续进张。只有速度没塌、对手未抢跑时，才继续向清一色投资。', nextDraws: '6万、7万、2万',
  },
  {
    id: 'qiduizi-window', title: '对子密集 · 万门宽床', startingHand: '112233445566万 78条', route: '七对自摸',
    condition: '三家对手缺万；你有六组万子对子，万门宽床虽大，但顺子路线反而会拆对子。',
    teachingGoal: '优先守住对子并找第七对；不要因为万门宽床就机械追清一色。', nextDraws: '7条、8条、7万',
  },
  {
    id: 'ordinary-selfdraw', title: '两门都活 · 万门未够集中', startingHand: '12345678万 345678条', route: '普通自摸',
    condition: '三家对手缺万；你有万门宽床，但另一门搭子也很顺，万门集中度不够。',
    teachingGoal: '先把宽叫和自摸效率做出来；若万子不连续补强，就别硬把条子全部拆掉。', nextDraws: '2条、9万、6条',
  },
  {
    id: 'cash-out', title: '对手抢跑 · 万门上牌差', startingHand: '1234569万 3456789条', route: '素胡走人',
    condition: '三家对手缺万；你有万门宽床但孤张多，对手会较早副露且万子补张不连贯。',
    teachingGoal: '确认对手抢跑后收缩目标：先下叫、先兑现，不为低概率大牌继续拖巡。', nextDraws: '1条、9条、4万',
  },
  {
    id: 'late-push', title: '万门成型边缘 · 再推一巡', startingHand: '112345678899万 46条', route: '清一色',
    condition: '三家对手缺万；你已有十二张万子但还有一组条子搭，清一色临门时要比较速度与收益。',
    teachingGoal: '不是万子多就必冲：只有补张仍连贯、叫口不缩水时，才值得再推一巡。', nextDraws: '7万、5条、2万',
  },
  {
    id: 'defensive-convert', title: '宽床受阻 · 两门转和', startingHand: '123456789万 34567条', route: '普通自摸',
    condition: '三家对手缺万；万门数量够多，但条子已有完整搭子，且中盘可能出现副露压力。',
    teachingGoal: '宽床不是单行道：保住两门连接，先做宽叫；对手推进后能立刻把进攻转换为安全。', nextDraws: '8条、4万、6条',
  },
]

export function getWideBedScenario(seed: number): WideBedScenario {
  return WIDE_BED_SCENARIOS[Math.abs(seed) % WIDE_BED_SCENARIOS.length]
}

/** 专项训练的河牌是明确的公开证据；不再用随机剩余牌填充剧情。 */
function dealTrainingRiver(pool: TileInstance[], specification: string): TileInstance[] {
  return sortTiles(takeSpecifiedTiles(pool, specification))
}

/** 残局保留牌墙也写死，保证每次练到的是同一套“已知牌河 + 十张未知牌”。 */
function dealTrainingWall(pool: TileInstance[], specification: string): TileInstance[] {
  return takeSpecifiedTiles(pool, specification)
}

function setTrainingMeld(player: PlayerState, pool: TileInstance[], kind: 'peng' | 'anGang', specification: string, fromPlayer: PlayerId): void {
  player.melds.push({ kind, tiles: takeSpecifiedTiles(pool, specification), fromPlayer })
}

/**
 * 固定模板负责保证专项题有明确目标；进入时再按 seed 对整副牌做花色置换和点数镜像，
 * 让结构、活张和规则不变，但每次看到的牌局不是同一张题面。
 */
function varySpecialTrainingPresentation(state: GameState, seed: number): GameState {
  const suitPermutations: readonly (readonly TileType[])[] = [
    ['万', '条', '筒'], ['万', '筒', '条'], ['条', '万', '筒'],
    ['条', '筒', '万'], ['筒', '万', '条'], ['筒', '条', '万'],
  ]
  const variant = Math.abs(seed)
  const sourceSuits: readonly TileType[] = ['万', '条', '筒']
  const targetSuits = suitPermutations[variant % suitPermutations.length]
  const suitMap = new Map<TileType, TileType>(sourceSuits.map((suit, index) => [suit, targetSuits[index]]))
  const mirrorRanks = Math.floor(variant / suitPermutations.length) % 2 === 1
  const remapTile = (tile: TileInstance) => {
    tile.type = suitMap.get(tile.type)!
    if (mirrorRanks)
      tile.value = 10 - tile.value
  }
  for (const tile of state.wall)
    remapTile(tile)
  for (const player of state.players) {
    for (const tile of player.hand)
      remapTile(tile)
    for (const tile of player.discards)
      remapTile(tile)
    for (const meld of player.melds)
      for (const tile of meld.tiles)
        remapTile(tile)
    if (player.dingque !== null)
      player.dingque = suitMap.get(player.dingque)!
    player.hand = sortTiles(player.hand)
    player.discards = sortTiles(player.discards)
  }
  return state
}

function createRandomWideTenpaiTraining(seed: number, styles: readonly AIStyle[]): GameState {
  const random = createSeededRandom(seed)
  const pool = shuffleTiles(createTileSet(), random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null), createPlayer(1, styles[0]), createPlayer(2, styles[1]), createPlayer(3, styles[2]),
  ]
  // 先确定要练的“听口形状”，再从整副牌随机落位；题目变化来自实际手牌、河牌与墙牌，而不是换皮。
  const primarySuit = (['万', '条', '筒'] as const)[random.nextInt(3)]
  const secondarySuit = (['万', '条', '筒'] as const).filter(suit => suit !== primarySuit)[random.nextInt(2)]
  const rankPatterns = [
    [1, 1, 2, 3, 4, 4, 5, 6, 7, 7, 8, 9, 9, 5],
    [1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 8, 9, 3, 6],
    [1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 9, 2, 5],
    [2, 2, 3, 4, 5, 5, 6, 7, 7, 8, 8, 9, 1, 4],
  ] as const
  const pattern = rankPatterns[random.nextInt(rankPatterns.length)]
  const splitAt = 9 + random.nextInt(3)
  // 牌谱语法必须是“数字串 + 花色”（如 112345万），不能把每张牌重复写成 1万1万。
  const primaryTiles = `${pattern.slice(0, splitAt).join('')}${primarySuit}`
  const secondaryTiles = `${pattern.slice(splitAt).join('')}${secondarySuit}`
  players[0].hand = dealTrainingHand(pool, `${primaryTiles} ${secondaryTiles}`)
  players[0].dingque = (['万', '条', '筒'] as const).find(suit => suit !== primarySuit && suit !== secondarySuit)!
  for (const playerId of [1, 2, 3] as const) {
    players[playerId].hand = sortTiles(pool.splice(0, 13))
    players[playerId].dingque = recommendDingque(players[playerId].hand)
  }
  const wall = pool.splice(0, 10)
  const revealed = sortTiles(pool.splice(0))
  players[1].discards = revealed.slice(0, 15)
  players[2].discards = revealed.slice(15, 30)
  players[3].discards = revealed.slice(30, 45)
  return {
    rulesVersion: MILESTONE_1_RULES.version, seed, phase: 'discarding', players, wall, dealer: 0, currentPlayer: 0,
    lastDrawnTileId: players[0].hand[players[0].hand.length - 1]?.id ?? null, lastDrawWasReplacement: false, lastDrawWasLastTile: false,
    responseWindow: null, kongContext: null, endReason: null, nextEventSequence: 1, events: [],
  }
}

function createRandomJingoudiaoTraining(seed: number, styles: readonly AIStyle[]): GameState {
  const random = createSeededRandom(seed)
  const pool = shuffleTiles(createTileSet(), random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null), createPlayer(1, styles[0]), createPlayer(2, styles[1]), createPlayer(3, styles[2]),
  ]
  // 先确定四副碰的骨架，再把两张候选、十张牌墙和公开河牌从同一副108张牌中真实扣除。
  // 骨架、候选单吊和公开存量均由题库编号共同决定，避免单纯换花色或数字平移。
  const meldSuit = (['万', '条', '筒'] as const)[random.nextInt(3)]
  const candidateSuit = (['万', '条', '筒'] as const).filter(suit => suit !== meldSuit)[random.nextInt(2)]
  const meldPatterns = [
    [1, 2, 4, 7], [1, 3, 5, 8], [2, 3, 6, 9], [2, 4, 5, 7], [1, 4, 6, 8],
    [2, 5, 7, 9], [1, 3, 6, 7], [3, 4, 6, 9], [1, 2, 6, 8], [3, 5, 7, 8],
  ] as const
  const candidatePatterns = [
    [1, 4], [1, 7], [2, 5], [2, 8], [3, 6], [3, 9], [4, 7], [4, 9], [5, 8], [6, 9],
  ] as const
  const meldValues = meldPatterns[random.nextInt(meldPatterns.length)]
  const candidates = candidatePatterns[random.nextInt(candidatePatterns.length)]
  for (const [index, value] of meldValues.entries())
    setTrainingMeld(players[0], pool, 'peng', `${value}${value}${value}${meldSuit}`, ([1, 2, 3, 1] as const)[index])
  players[0].hand = dealTrainingHand(pool, `${candidates[0]}${candidates[1]}${candidateSuit}`)
  players[0].dingque = (['万', '条', '筒'] as const).find(suit => suit !== meldSuit && suit !== candidateSuit)!
  for (const playerId of [1, 2, 3] as const) {
    players[playerId].hand = sortTiles(pool.splice(0, 13))
    players[playerId].dingque = recommendDingque(players[playerId].hand)
  }
  const wall = pool.splice(0, 10)
  const revealed = sortTiles(pool.splice(0))
  players[1].discards = revealed.slice(0, 15)
  players[2].discards = revealed.slice(15, 30)
  players[3].discards = revealed.slice(30, 45)
  return {
    rulesVersion: MILESTONE_1_RULES.version, seed, phase: 'discarding', players, wall, dealer: 0, currentPlayer: 0,
    lastDrawnTileId: players[0].hand[players[0].hand.length - 1]?.id ?? null, lastDrawWasReplacement: false, lastDrawWasLastTile: false,
    responseWindow: null, kongContext: null, endReason: null, nextEventSequence: 1, events: [],
  }
}

function createRandomEndgameCountTraining(seed: number, styles: readonly AIStyle[]): GameState {
  const random = createSeededRandom(seed)
  const pool = shuffleTiles(createTileSet(), random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null), createPlayer(1, styles[0]), createPlayer(2, styles[1]), createPlayer(3, styles[2]),
  ]
  // 末十张的关键不是背一副牌，而是从随机的两门手牌、45 张公开河牌和 10 张牌墙里重新扣张。
  const playerDingque = (['万', '条', '筒'] as const)[random.nextInt(3)]
  players[0].hand = dealTrainingHandWithoutSuit(pool, playerDingque, 14)
  players[0].dingque = playerDingque
  for (const playerId of [1, 2, 3] as const) {
    players[playerId].hand = sortTiles(pool.splice(0, 13))
    players[playerId].dingque = recommendDingque(players[playerId].hand)
  }
  const wall = pool.splice(0, 10)
  const revealed = sortTiles(pool.splice(0))
  players[1].discards = revealed.slice(0, 15)
  players[2].discards = revealed.slice(15, 30)
  players[3].discards = revealed.slice(30, 45)
  return {
    rulesVersion: MILESTONE_1_RULES.version, seed, phase: 'discarding', players, wall, dealer: 0, currentPlayer: 0,
    lastDrawnTileId: players[0].hand[players[0].hand.length - 1]?.id ?? null, lastDrawWasReplacement: false, lastDrawWasLastTile: false,
    responseWindow: null, kongContext: null, endReason: null, nextEventSequence: 1, events: [],
  }
}

export function createSpecialTrainingGame(seed: number, kind: SpecialTrainingKind, scenarioIndex?: number, randomizePresentation = false): GameState {
  const random = createSeededRandom(seed)
  const pool = shuffleTiles(createTileSet(), random)
  const styles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], random)
  // 最后十张只允许进入 500 局残局仓库。无论调用方是否传入展示随机开关，
  // 都不能回落到下方的历史固定模板，否则旧页面或测试入口会再次出现同一题面。
  if (kind === 'endgame-count') {
    const libraryIndex = scenarioIndex ?? seed
    const librarySeed = getEndgameCountLibrarySeed(libraryIndex)
    const libraryStyles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], createSeededRandom(librarySeed))
    return createRandomEndgameCountTraining(librarySeed, libraryStyles)
  }
  if (kind === 'endgame-qingyise-tenpai') {
    const libraryIndex = scenarioIndex ?? seed
    const librarySeed = getWideTenpaiLibrarySeed(libraryIndex)
    const libraryStyles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], createSeededRandom(librarySeed))
    return createRandomWideTenpaiTraining(librarySeed, libraryStyles)
  }
  if (kind === 'attack-jingoudiao') {
    const libraryIndex = scenarioIndex ?? seed
    const librarySeed = getJingoudiaoLibrarySeed(libraryIndex)
    const libraryStyles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], createSeededRandom(librarySeed))
    return createRandomJingoudiaoTraining(librarySeed, libraryStyles)
  }
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null), createPlayer(1, styles[0]), createPlayer(2, styles[1]), createPlayer(3, styles[2]),
  ]
  const selectedScenarioIndex = scenarioIndex === undefined
    ? Math.abs(seed) % getSpecialTrainingScenarioCount(kind)
    : Math.abs(scenarioIndex) % getSpecialTrainingScenarioCount(kind)
  if (kind === 'attack-qingyise') {
    const scenario = getWideBedScenario(selectedScenarioIndex)
    // 这不是一张已经发展到中盘的“清一色成品图”。三家对手都在定缺万后刚清完缺门，
    // 你则定缺筒并持有万门宽床：牌河为空、无人副露，从第一巡按来牌与对手推进决定路线。
    players[0].hand = dealTrainingHand(pool, scenario.startingHand)
    // `draw` 从数组尾部取牌；脚本只确保局面会出现信息，不把一条路线直接喂到你嘴边。
    // 前四摸分别给上家、对家、下家、你；你每次摸到的是第 4、8 张。
    const drawScript = scenario.id === 'qingyise-window'
      ? '57条 6筒 8条 6万 1条 2万 4条 7万'
      : scenario.id === 'qiduizi-window'
        ? '5条 7万 6条 7条 4万 7筒 1条 8条'
        : scenario.id === 'ordinary-selfdraw'
          ? '9条 2万 1万 6条 9万 5条 7万 2条'
          : scenario.id === 'late-push'
            ? '3条 8万 5条 7万 1条 2万 6条 9万'
            : scenario.id === 'defensive-convert'
              ? '2万 6条 1条 4万 8条 7万 3条 5万'
              : '2万 7条 3条 1条 8万 1筒 6条 9条'
    const scriptedDraws = dealTrainingWall(pool, drawScript)
    for (const playerId of [1, 2, 3] as const)
      players[playerId].hand = dealTrainingHandWithoutSuit(pool, '万', 13)
    players[0].dingque = '筒'
    for (const playerId of [1, 2, 3] as const)
      players[playerId].dingque = '万'
    pool.push(...[...scriptedDraws].reverse())
  }
  else {
    const hands: Record<'defense-big-hands' | 'defense-race-qingyise', [string, string, string, string]> = {
      'defense-big-hands': selectedScenarioIndex === 0
        ? ['123456789万 34567条', '1112223334条', '1112223334445万', '1112223334445筒']
        : selectedScenarioIndex === 1
          ? ['1123456789万 456条', '2223334445筒', '1122334455667万', '1112223337778条']
          : ['123456789条 34567万', '1112223334万', '5556667778889筒', '5556668889999万'],
      // 同门竞速轮换：条子抢门、万子抢门、筒子抢门三种公开赛跑。
      'defense-race-qingyise': selectedScenarioIndex === 0
        ? ['11234567894569条', '222条 1234567万', '123456789筒 1234万', '56789万 12345678筒']
        : selectedScenarioIndex === 1
          ? ['11234567894569万', '222万 1234567条', '123456789筒 1234条', '56789条 12345678筒']
          : ['11234567894569筒', '222筒 1234567万', '123456789条 1234万', '56789万 12345678条'],
    }
    for (const [index, hand] of hands[kind].entries())
      players[index as PlayerId].hand = dealTrainingHand(pool, hand)
    for (const player of players) {
      if (player.dingque === null)
        player.dingque = recommendDingque(player.hand)
    }
  }
  if (kind === 'defense-big-hands' || kind === 'defense-race-qingyise') {
    if (kind === 'defense-big-hands') {
      const defenseEvidence = selectedScenarioIndex === 0
        ? { meld: '777条', rivers: ['45689条', '6789筒', '56789万'] }
        : selectedScenarioIndex === 1
          ? { meld: '777筒', rivers: ['45689筒', '6789条', '56789万'] }
          : { meld: '777万', rivers: ['1234条', '6789筒', '56789条'] }
      setTrainingMeld(players[1], pool, 'peng', defenseEvidence.meld, 2)
      players[1].discards = dealTrainingRiver(pool, defenseEvidence.rivers[0])
      players[2].discards = dealTrainingRiver(pool, defenseEvidence.rivers[1])
      players[3].discards = dealTrainingRiver(pool, defenseEvidence.rivers[2])
    }
    else {
      // 同门竞速的目标门随题组轮换，公开碰牌和河牌都给出可见证据。
      const raceEvidence = selectedScenarioIndex === 0
        ? { meld: '888条', rivers: ['45689万', '5678筒', '1234万'] }
        : selectedScenarioIndex === 1
          ? { meld: '888万', rivers: ['45689条', '5678筒', '1234条'] }
          : { meld: '888筒', rivers: ['45689万', '5678条', '1234万'] }
      setTrainingMeld(players[1], pool, 'peng', raceEvidence.meld, 2)
      players[1].discards = dealTrainingRiver(pool, raceEvidence.rivers[0])
      players[2].discards = dealTrainingRiver(pool, raceEvidence.rivers[1])
      players[3].discards = dealTrainingRiver(pool, raceEvidence.rivers[2])
    }
  }
  const state: GameState = {
    rulesVersion: MILESTONE_1_RULES.version, seed, phase: 'discarding', players, wall: pool, dealer: 0, currentPlayer: 0,
    lastDrawnTileId: players[0].hand[players[0].hand.length - 1]?.id ?? null, lastDrawWasReplacement: false, lastDrawWasLastTile: false,
    responseWindow: null, kongContext: null, endReason: null, nextEventSequence: 1, events: [],
  }
  return randomizePresentation ? varySpecialTrainingPresentation(state, seed) : state
}

export function createInitialGame(seed: number, opponentConfigs?: readonly OpponentConfig[]): GameState {
  const random = createSeededRandom(seed)
  const dealer = random.nextInt(4) as PlayerId
  const styles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null),
    createPlayer(1, opponentConfigs?.[0]?.aiStyle ?? styles[0], opponentConfigs?.[0]?.name),
    createPlayer(2, opponentConfigs?.[1]?.aiStyle ?? styles[1], opponentConfigs?.[1]?.name),
    createPlayer(3, opponentConfigs?.[2]?.aiStyle ?? styles[2], opponentConfigs?.[2]?.name),
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
