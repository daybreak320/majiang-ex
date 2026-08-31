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

export interface WideTenpaiScenario {
  title: string
  goal: string
  kind: 'qingyise' | 'kongDraw'
}

export function getWideTenpaiScenario(seed: number): WideTenpaiScenario {
  return Math.abs(seed) % 2 === 0
    ? { title: '清一色残局 · 下宽叫', goal: '同样一打即叫，比较谁留下的叫口更多、活张更宽。' , kind: 'qingyise' }
    : { title: '杠开残局 · 下宽叫', goal: '杠后补张不等于盲冲；比较留下哪张单吊牌，才有更多真正活张。', kind: 'kongDraw' }
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
  id: 'qingyise-window' | 'qiduizi-window' | 'ordinary-selfdraw' | 'cash-out'
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

export function createSpecialTrainingGame(seed: number, kind: SpecialTrainingKind): GameState {
  const random = createSeededRandom(seed)
  const pool = shuffleTiles(createTileSet(), random)
  const styles = shuffleValues<AIStyle>(['aggressive', 'steady', 'efficient'], random)
  const players: [PlayerState, PlayerState, PlayerState, PlayerState] = [
    createPlayer(0, null), createPlayer(1, styles[0]), createPlayer(2, styles[1]), createPlayer(3, styles[2]),
  ]
  let reservedWideTenpaiWall: TileInstance[] | null = null
  if (kind === 'attack-jingoudiao') {
    // 金钩钓残局：四副碰牌已完成，只剩两张候选牌。每次摸牌后必须二选一留单吊，直到胡牌。
    setTrainingMeld(players[0], pool, 'peng', '111万', 1)
    setTrainingMeld(players[0], pool, 'peng', '222万', 2)
    setTrainingMeld(players[0], pool, 'peng', '333万', 3)
    setTrainingMeld(players[0], pool, 'peng', '444万', 1)
    players[0].hand = dealTrainingHand(pool, '59筒')
    players[0].dingque = '条'
    // 公开河牌故意让 5 筒与 9 筒的剩余张不同；玩家不能只看“单吊”二字，必须扣张换听。
    players[1].discards = dealTrainingRiver(pool, '55筒 678条')
    players[2].discards = dealTrainingRiver(pool, '9筒 123条')
    players[3].discards = dealTrainingRiver(pool, '456条')
    const scriptedDraws = dealTrainingWall(pool, '1万 2条 3条 9筒 4万 5条 6条 5筒')
    for (const playerId of [1, 2, 3] as const) {
      players[playerId].hand = sortTiles(pool.splice(0, 13))
      players[playerId].dingque = recommendDingque(players[playerId].hand)
    }
    pool.push(...[...scriptedDraws].reverse())
  }
  else if (kind === 'attack-qingyise') {
    const scenario = getWideBedScenario(seed)
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
    const wideTenpai = kind === 'endgame-qingyise-tenpai' ? getWideTenpaiScenario(seed) : null
    // 固定残局先锁住十张未知牌，避免对手暗手随机吃掉关键听牌张。
    reservedWideTenpaiWall = wideTenpai?.kind === 'kongDraw'
      ? dealTrainingWall(pool, '55筒 12345678条')
      : null
    const hands: Record<Exclude<SpecialTrainingKind, 'attack-qingyise'>, [string, string, string, string]> = {
      // 下宽叫专项轮换两类残局：清一色一打即叫 / 杠开补张后二选一单吊。
      'endgame-qingyise-tenpai': wideTenpai?.kind === 'kongDraw'
        ? ['59筒', '123456789条 1234筒', '123467889筒 1234条', '123467889筒 5678条']
        : ['11223344556789万', '123456789条 1234筒', '123456789筒 1234条', '123456789条 5678筒'],
      // 金钩钓在上方单独构造，此处只是满足类型完备，永远不会进入本分支。
      'attack-jingoudiao': ['123456789万 12345条', '123456789条 1234筒', '123456789筒 1234条', '123456789条 5678筒'],
      'defense-big-hands': ['123456789万 34567条', '1112223334条', '1112223334445筒', '1112223334445万'],
      // 同样避开清七对成牌；对手用公开 888条表露目标门，其余暗手不越过牌池上限。
      'defense-race-qingyise': ['11234567894569条', '222条 1234567万', '123456789筒 1234万', '56789万 12345678筒'],
      'endgame-count': ['123456789万 34567条', '1122334455667筒', '1112223334445万', '123456789条 5678筒'],
    }
    for (const [index, hand] of hands[kind].entries())
      players[index as PlayerId].hand = dealTrainingHand(pool, hand)
    if (wideTenpai?.kind === 'kongDraw') {
      // 杠开分支：四副暗杠已成，补张后手里两张候选牌；练习“杠上听哪张更活”，而非盲目追杠。
      setTrainingMeld(players[0], pool, 'anGang', '1111万', 0)
      setTrainingMeld(players[0], pool, 'anGang', '2222万', 0)
      setTrainingMeld(players[0], pool, 'anGang', '3333万', 0)
      setTrainingMeld(players[0], pool, 'anGang', '4444万', 0)
      players[0].dingque = '条'
    }
    for (const player of players) {
      if (player.dingque === null)
        player.dingque = recommendDingque(player.hand)
    }
  }
  if (kind === 'attack-jingoudiao' && players[1].discards.length === 0) {
    // 兼容保护：金钩钓残局的公开河牌已在上方固定，不再覆盖为普通进攻局的随机河牌。
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
  if (kind === 'endgame-count' || kind === 'endgame-qingyise-tenpai') {
    // 固定十张残局墙：用已知牌河扣张，而不是把随机余牌伪装成一道残局题。
    // 下宽叫专项按题面保留不同牌墙：清一色保留万子宽叫，杠开保留两种单吊的真实余张差异。
    const wall = reservedWideTenpaiWall ?? dealTrainingWall(pool, kind === 'endgame-qingyise-tenpai'
      ? '124579万 1234条'
      : '123456789条 9筒')
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
