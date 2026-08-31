import type { Tile, TileType } from '../types'
import type {
  AIStyle,
  GameCommand,
  GamePhase,
  GameState,
  LegalAction,
  Meld,
  PlayerId,
  TileInstance,
} from './types'
import {
  assessDiscardSafety,
  assessGangStructure,
  countOpportunities,
  rateOpportunity,
} from '../knowledge/mahjongTheory'
import { compareTiles, createInitialGame, recommendDingque } from './core'
import { executeCommand, getLegalActions } from './engine'
import { MILESTONE_1_RULES } from './rules'

export interface AIPlayerView {
  id: PlayerId
  discards: TileInstance[]
  melds: Meld[]
  score: number
  dingque: TileType | null
  hasWon: boolean
}

export interface AISelfView extends AIPlayerView {
  hand: TileInstance[]
  aiStyle: AIStyle
}

export interface AIResponseView {
  kind: 'discard' | 'buGang'
  sourcePlayer: PlayerId
  tile: TileInstance
  eligiblePlayers: PlayerId[]
  respondedPlayers: PlayerId[]
}

export interface AIView {
  self: AISelfView
  players: [AIPlayerView, AIPlayerView, AIPlayerView, AIPlayerView]
  wallRemaining: number
  phase: GamePhase
  currentPlayer: PlayerId
  response: AIResponseView | null
}

export interface AIAdvanceResult {
  state: GameState
  command: GameCommand | null
}

interface Structure {
  groups: number
  pairs: number
  adjacent: number
  gaps: number
  isolated: number
  edges: number
  concentration: number
}

const PLAYER_IDS: readonly PlayerId[] = [0, 1, 2, 3]

function publicPlayer(state: GameState, playerId: PlayerId): AIPlayerView {
  const player = state.players[playerId]
  return {
    id: player.id,
    discards: structuredClone(player.discards),
    melds: structuredClone(player.melds),
    score: player.score,
    dingque: player.dingque,
    hasWon: player.hasWon,
  }
}

export function buildAIView(state: GameState, playerId: PlayerId): AIView {
  const player = state.players[playerId]
  const players = PLAYER_IDS.map(id => publicPlayer(state, id)) as AIView['players']
  return {
    self: {
      ...players[playerId],
      hand: structuredClone(player.hand),
      aiStyle: player.aiStyle ?? 'efficient',
    },
    players,
    wallRemaining: state.wall.length,
    phase: state.phase,
    currentPlayer: state.currentPlayer,
    response: state.responseWindow === null
      ? null
      : {
          kind: state.responseWindow.kind,
          sourcePlayer: state.responseWindow.sourcePlayer,
          tile: structuredClone(state.responseWindow.tile),
          eligiblePlayers: [...state.responseWindow.eligiblePlayers],
          respondedPlayers: state.responseWindow.eligiblePlayers.filter(id => state.responseWindow?.choices[id] !== undefined),
        },
  }
}

function analyzeStructure(tiles: readonly TileInstance[]): Structure {
  let groups = 0
  let pairs = 0
  let adjacent = 0
  let gaps = 0
  let isolated = 0
  let edges = 0
  let concentration = 0

  for (const type of MILESTONE_1_RULES.tileTypes) {
    const counts = Array.from({ length: 10 }, () => 0)
    for (const tile of tiles) {
      if (tile.type === type)
        counts[tile.value]++
    }
    const suitCount = counts.reduce((sum, count) => sum + count, 0)
    concentration += suitCount * suitCount
    for (let value = 1; value <= 9; value++) {
      groups += Math.floor(counts[value] / 3)
      pairs += counts[value] >= 2 ? 1 : 0
      if (value < 9)
        adjacent += Math.min(counts[value], counts[value + 1])
      if (value < 8)
        gaps += Math.min(counts[value], counts[value + 2])
      if (counts[value] > 0) {
        const connected = [value - 2, value - 1, value + 1, value + 2]
          .some(nearby => counts[nearby] > 0)
        if (counts[value] === 1 && !connected)
          isolated++
        if (value === 1 || value === 9)
          edges += counts[value]
      }
    }
  }
  return { groups, pairs, adjacent, gaps, isolated, edges, concentration }
}

function structureScore(tiles: readonly TileInstance[], style: AIStyle): number {
  const structure = analyzeStructure(tiles)
  if (style === 'qingyise') {
    // 重度清一色爱好者：宁可牺牲部分顺子效率，也会强烈保留单门集中度。
    return structure.groups * 11
      + structure.pairs * 6
      + structure.adjacent * 2
      + structure.gaps
      - structure.isolated
      - structure.edges * 0.1
      + structure.concentration * 0.42
  }
  if (style === 'aggressive' || style === 'pengManiac') {
    return structure.groups * (style === 'pengManiac' ? 15 : 13)
      + structure.pairs * 7
      + structure.adjacent * 2.5
      + structure.gaps * 1.5
      - structure.isolated * 1.5
      - structure.edges * 0.15
      + structure.concentration * 0.08
  }
  return structure.groups * 10
    + structure.pairs * 5
    + structure.adjacent * 4
    + structure.gaps * 2.5
    - structure.isolated * 2
    - structure.edges * 0.35
}

function publicDanger(view: AIView, tile: TileInstance): number {
  const upper = view.players[(view.self.id + 3) % 4 as PlayerId]
  const opposite = view.players[(view.self.id + 2) % 4 as PlayerId]
  const lower = view.players[(view.self.id + 1) % 4 as PlayerId]
  const activeOpponents = view.players.filter(opponent => opponent.id !== view.self.id && !opponent.hasWon)
  const wasDiscarded = (opponent: AIPlayerView) => opponent.discards
    .some(discard => discard.type === tile.type && discard.value === tile.value)
  // 来源：成都册第二章第三节、第三章“进攻、防守与综合”及“实用小技巧”。
  return assessDiscardSafety({
    value: tile.value,
    isLateGame: view.wallRemaining <= 40,
    familiarBy: {
      upper: wasDiscarded(upper),
      opposite: wasDiscarded(opposite),
      lower: wasDiscarded(lower),
    },
    opponentMeldCount: activeOpponents.reduce((sum, opponent) => sum + opponent.melds.length, 0),
    sameSuitOpponentMeldCount: activeOpponents.reduce((sum, opponent) =>
      sum + opponent.melds.filter(meld => meld.tiles[0]?.type === tile.type).length, 0),
    dingqueOpponentCount: activeOpponents.filter(opponent => opponent.dingque === tile.type).length,
  }).danger * 4
}

function compareActions(a: LegalAction, b: LegalAction): number {
  const rank = (action: LegalAction) => action.type === 'gang'
    ? ['anGang', 'buGang', 'mingGang'].indexOf(action.kind)
    : 0
  if (a.type === 'gang' && b.type === 'gang')
    return rank(a) - rank(b) || a.tileId.localeCompare(b.tileId)
  return JSON.stringify(a).localeCompare(JSON.stringify(b))
}

/**
 * 机会数加分项（朱扬《麻将"机会数"理论与实战》核心落地）：
 * 出牌后手牌的有效进张越多，牌效越高。
 * 权重按风格区分：效率型最看重牌效，进攻型次之（兼顾大牌潜力），稳健型最低（更看安全）。
 * 结构分看不到"已见牌扣减"，机会数能感知牌河/鸣牌，二者互补。
 */
function opportunityScore(
  tiles: readonly TileInstance[],
  visible: readonly Tile[],
  style: AIStyle,
  dingque: TileType | null,
): number {
  const weight = style === 'efficient' ? 0.9 : style === 'aggressive' ? 0.7 : style === 'qingyise' ? 0.5 : style === 'turtle' ? 0.35 : style === 'pengManiac' ? 0.65 : 0.55
  return countOpportunities(tiles, visible, { dingque }).total * weight
}

/** 所有玩家公开的牌河与鸣牌（含自己的弃牌——打出即死，不再可摸） */
function publicVisible(view: AIView): Tile[] {
  return view.players.flatMap(player => [...player.discards, ...player.melds.flatMap(meld => meld.tiles)])
}

interface GangProjection {
  hand: TileInstance[]
  melds: Meld[]
  newlyVisible: TileInstance[]
}

function projectGang(state: GameState, playerId: PlayerId, action: Extract<LegalAction, { type: 'gang' }>): GangProjection | null {
  const player = state.players[playerId]
  if (action.kind === 'anGang') {
    const selected = player.hand.find(tile => tile.id === action.tileId)
    if (selected === undefined)
      return null
    const gangTiles = player.hand.filter(tile => tile.type === selected.type && tile.value === selected.value)
    if (gangTiles.length !== 4)
      return null
    const ids = new Set(gangTiles.map(tile => tile.id))
    return {
      hand: player.hand.filter(tile => !ids.has(tile.id)),
      melds: [...player.melds, { kind: 'anGang', tiles: gangTiles, fromPlayer: null }],
      newlyVisible: gangTiles,
    }
  }

  if (action.kind === 'buGang') {
    const selected = player.hand.find(tile => tile.id === action.tileId)
    if (selected === undefined)
      return null
    const meldIndex = player.melds.findIndex(meld =>
      meld.kind === 'peng' && meld.tiles[0]?.type === selected.type && meld.tiles[0]?.value === selected.value)
    if (meldIndex < 0)
      return null
    const melds = player.melds.map((meld, index): Meld => index === meldIndex
      ? { ...meld, kind: 'buGang', tiles: [...meld.tiles, selected] }
      : meld)
    return {
      hand: player.hand.filter(tile => tile.id !== selected.id),
      melds,
      newlyVisible: [selected],
    }
  }

  const called = state.responseWindow?.tile
  if (called === undefined)
    return null
  const matching = player.hand
    .filter(tile => tile.type === called.type && tile.value === called.value)
    .slice(0, 3)
  if (matching.length !== 3)
    return null
  const ids = new Set(matching.map(tile => tile.id))
  return {
    hand: player.hand.filter(tile => !ids.has(tile.id)),
    melds: [...player.melds, { kind: 'mingGang', tiles: [...matching, called], fromPlayer: state.responseWindow!.sourcePlayer }],
    newlyVisible: matching,
  }
}

function bestReferenceOpportunity(
  state: GameState,
  playerId: PlayerId,
  legal: readonly LegalAction[],
  visible: readonly Tile[],
): { total: number, structuralWaits: number } {
  const player = state.players[playerId]
  if (state.phase === 'responding') {
    const opportunity = countOpportunities(player.hand, visible, {
      dingque: player.dingque,
      melds: player.melds,
    })
    return { total: opportunity.total, structuralWaits: opportunity.structuralWaits.length }
  }

  let best = { total: 0, structuralWaits: 0 }
  for (const action of legal) {
    if (action.type !== 'discard')
      continue
    const opportunity = countOpportunities(
      player.hand.filter(tile => tile.id !== action.tileId),
      visible,
      { dingque: player.dingque, melds: player.melds },
    )
    if (opportunity.total > best.total
      || (opportunity.total === best.total && opportunity.structuralWaits.length > best.structuralWaits)) {
      best = { total: opportunity.total, structuralWaits: opportunity.structuralWaits.length }
    }
  }
  return best
}

function chooseStructurePreservingGang(
  state: GameState,
  playerId: PlayerId,
  legal: readonly LegalAction[],
): Extract<LegalAction, { type: 'gang' }> | undefined {
  const gangs = legal
    .filter((action): action is Extract<LegalAction, { type: 'gang' }> => action.type === 'gang')
    .sort(compareActions)
  if (gangs.length === 0)
    return undefined
  const visible = publicVisible(buildAIView(state, playerId))
  const reference = bestReferenceOpportunity(state, playerId, legal, visible)
  // 来源：成都册“杠牌打法秘籍”；机会数损失基准来自第二章第一节。
  return gangs.find((gang) => {
    const projection = projectGang(state, playerId, gang)
    if (projection === null)
      return false
    return assessGangStructure(projection.hand, projection.melds, {
      dingque: state.players[playerId].dingque,
      visible: [...visible, ...projection.newlyVisible],
      referenceOpportunity: reference.total,
      referenceStructuralWaits: reference.structuralWaits,
    }).preservesStructure
  })
}

function chooseDiscard(state: GameState, playerId: PlayerId, actions: Extract<LegalAction, { type: 'discard' }>[]): LegalAction {
  const view = buildAIView(state, playerId)
  const style = view.self.aiStyle
  const visible = publicVisible(view)
  const dangerScale = (style === 'steady' || style === 'turtle')
    ? (style === 'turtle' ? 2.25 : 1) * (1 + view.players.reduce((sum, player) => sum + player.melds.length, 0) * 0.12)
    : 0
  return [...actions].sort((a, b) => {
    const tileA = view.self.hand.find(tile => tile.id === a.tileId)!
    const tileB = view.self.hand.find(tile => tile.id === b.tileId)!
    const afterA = view.self.hand.filter(tile => tile.id !== a.tileId)
    const afterB = view.self.hand.filter(tile => tile.id !== b.tileId)
    const dangerA = style === 'steady' || style === 'turtle' ? publicDanger(view, tileA) * dangerScale : 0
    const dangerB = style === 'steady' || style === 'turtle' ? publicDanger(view, tileB) * dangerScale : 0
    const scoreA = structureScore(afterA, style) + opportunityScore(afterA, visible, style, view.self.dingque) - dangerA
    const scoreB = structureScore(afterB, style) + opportunityScore(afterB, visible, style, view.self.dingque) - dangerB
    return scoreB - scoreA || compareTiles(tileA, tileB) || tileA.id.localeCompare(tileB.id)
  })[0]
}

function chooseResponse(state: GameState, playerId: PlayerId, legal: LegalAction[]): LegalAction {
  const player = state.players[playerId]
  const style = player.aiStyle ?? 'efficient'
  const gang = chooseStructurePreservingGang(state, playerId, legal)
  if (gang !== undefined)
    return gang

  const peng = legal.find((action): action is Extract<LegalAction, { type: 'peng' }> => action.type === 'peng')
  if (peng !== undefined) {
    if (style === 'aggressive')
      return peng
    const responseTile = state.responseWindow!.tile
    const matching = player.hand.filter(tile => tile.type === responseTile.type && tile.value === responseTile.value).slice(0, 2)
    const ids = new Set(matching.map(tile => tile.id))
    const before = structureScore(player.hand, style)
    const after = structureScore(player.hand.filter(tile => !ids.has(tile.id)), style)
    const meldGain = style === 'efficient' ? 6 : 4
    const caution = style === 'steady' ? 2 : style === 'turtle' ? 6 : 0
    if (after + meldGain >= before + caution)
      return peng
  }
  return legal.find(action => action.type === 'pass')!
}

export function chooseAICommand(state: GameState, playerId: PlayerId): GameCommand | null {
  const legal = getLegalActions(state, playerId)
  if (legal.length === 0)
    return null

  const hu = legal.find(action => action.type === 'hu')
  if (hu !== undefined)
    return { ...hu, playerId }

  if (state.phase === 'dingque') {
    const tileType = recommendDingque(state.players[playerId].hand)
    const action = legal.find(candidate => candidate.type === 'dingque' && candidate.tileType === tileType)
    return action === undefined ? null : { ...action, playerId }
  }

  if (state.phase === 'responding')
    return { ...chooseResponse(state, playerId, legal), playerId }

  const gang = chooseStructurePreservingGang(state, playerId, legal)
  if (gang !== undefined)
    return { ...gang, playerId }
  const discards = legal.filter((action): action is Extract<LegalAction, { type: 'discard' }> => action.type === 'discard')
  return discards.length === 0 ? null : { ...chooseDiscard(state, playerId, discards), playerId }
}

export function getAIReason(state: GameState, playerId: PlayerId, command: GameCommand): string {
  if (command.playerId !== playerId)
    return '该动作不属于当前 AI。'
  switch (command.type) {
    case 'hu': return '已有合法胡牌机会，优先胡牌。'
    case 'dingque': return `按手牌数量与连接结构推荐定缺${command.tileType}。`
    case 'gang': return command.kind === 'mingGang' ? '明杠可加快成牌并获得补张。' : '选择合法杠牌获得补张。'
    case 'peng': return '碰牌可形成刻子并加快手牌进度。'
    case 'pass': return '当前鸣牌对手牌结构帮助不足，选择过。'
    case 'discard': {
      const player = state.players[playerId]
      const tile = player.hand.find(candidate => candidate.id === command.tileId)
      if (tile === undefined)
        return '该出牌不在当前手牌中。'
      const after = player.hand.filter(candidate => candidate.id !== command.tileId)
      const visible = state.players.flatMap(p => [...p.discards, ...p.melds.flatMap(meld => meld.tiles)])
      const { total } = countOpportunities(after, visible, { dingque: player.dingque })
      const rating = rateOpportunity(total)
      const style = player.aiStyle ?? 'efficient'
      const base = `打出 ${tile.type}${tile.value} 后手牌机会数 ${total}（${rating}）`
      if (style === 'steady')
        return `${base}，兼顾公开信息中的出牌风险。`
      if (style === 'turtle')
        return `${base}，对手一有副露就优先找熟张，宁可放慢速度也不轻易冒险。`
      if (style === 'aggressive')
        return `${base}，保留成组、对子与做大牌潜力。`
      if (style === 'qingyise')
        return `${base}，优先把牌张集中到一门，哪怕会牺牲一部分即时牌效。`
      if (style === 'pengManiac')
        return `${base}，偏好保留自摸与杠后补张空间，只有结构站得住才会积极开杠。`
      return `${base}，优先保留有效进张。`
    }
  }
}

export function advanceAIOnce(state: GameState): AIAdvanceResult {
  if (state.phase === 'finished')
    return { state, command: null }

  let playerId: PlayerId | undefined
  if (state.phase === 'dingque')
    playerId = ([1, 2, 3] as const).find(id => state.players[id].dingque === null)
  else if (state.phase === 'responding')
    playerId = state.responseWindow?.eligiblePlayers.find(id => id !== 0 && state.responseWindow?.choices[id] === undefined)
  else if (state.currentPlayer !== 0)
    playerId = state.currentPlayer

  if (playerId === undefined)
    return { state, command: null }
  const command = chooseAICommand(state, playerId)
  if (command === null)
    return { state, command: null }
  const result = executeCommand(state, command)
  if (!result.ok)
    throw new Error(`AI 生成非法命令：${result.error}`)
  return { state: result.nextState, command }
}

export function runAIGame(seed: number, maxSteps = 5000): GameState {
  let state = createInitialGame(seed)
  for (let step = 0; step < maxSteps; step++) {
    if (state.phase === 'finished')
      return state
    let playerId: PlayerId | undefined
    if (state.phase === 'dingque')
      playerId = PLAYER_IDS.find(id => state.players[id].dingque === null)
    else if (state.phase === 'responding')
      playerId = state.responseWindow?.eligiblePlayers.find(id => state.responseWindow?.choices[id] === undefined)
    else
      playerId = state.currentPlayer
    if (playerId === undefined)
      throw new Error(`AI 对局在第 ${step + 1} 步处于无待响应玩家的异常阶段（阶段：${state.phase}）`)
    const command = chooseAICommand(state, playerId)
    if (command === null)
      throw new Error(`AI 对局在第 ${step + 1} 步无可执行命令（阶段：${state.phase}，玩家：${playerId}）`)
    const result = executeCommand(state, command)
    if (!result.ok)
      throw new Error(`AI 对局在第 ${step + 1} 步产生非法命令：${result.error}`)
    state = result.nextState
  }
  throw new Error(`AI 对局超过最大步数 ${maxSteps}（seed: ${seed}）`)
}
