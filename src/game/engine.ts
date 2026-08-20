import type {
  CommandResult,
  GameCommand,
  GameEvent,
  GameState,
  LegalAction,
  Meld,
  PlayerId,
  PlayerState,
  ResponseChoice,
  ResponseWindow,
  ScoreReason,
  SpecialWinKind,
  TileInstance,
  WinInfo,
} from './types'
import { chooseTimeoutDiscard, getLegalDiscards, recommendDingque, sortTiles } from './core'
import { MILESTONE_1_RULES } from './rules'
import { calculateScore } from './scoring'
import { settleFinal } from './settlement'

const PLAYER_IDS: readonly PlayerId[] = [0, 1, 2, 3]

function sameTile(a: TileInstance, b: TileInstance): boolean {
  return a.type === b.type && a.value === b.value
}

function cloneState(state: GameState): GameState {
  return structuredClone(state)
}

type UnsequencedGameEvent = GameEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, 'sequence'>
    : never
  : never

function emit(state: GameState, event: UnsequencedGameEvent): GameEvent {
  const sequenced = { ...event, sequence: state.nextEventSequence++ } as GameEvent
  state.events.push(sequenced)
  return sequenced
}

function nextActivePlayer(state: GameState, from: PlayerId): PlayerId | null {
  for (let distance = 1; distance <= 4; distance++) {
    const candidate = ((from + distance) % 4) as PlayerId
    if (!state.players[candidate].hasWon)
      return candidate
  }
  return null
}

function activeOpponents(state: GameState, playerId: PlayerId): PlayerState[] {
  return state.players.filter(player => player.id !== playerId && !player.hasWon)
}

function draw(state: GameState, playerId: PlayerId, replacement: boolean): boolean {
  if (state.wall.length === 0) {
    finish(state, 'wall_empty')
    return false
  }
  const tile = state.wall.pop()!
  const lastTile = state.wall.length === 0
  const player = state.players[playerId]
  player.hand = sortTiles([...player.hand, tile])
  player.passedWinValue = null
  state.currentPlayer = playerId
  state.phase = 'discarding'
  state.lastDrawnTileId = tile.id
  state.lastDrawWasReplacement = replacement
  state.lastDrawWasLastTile = lastTile
  emit(state, { type: 'tile_drawn', playerId, tile, replacement, lastTile })
  emit(state, { type: 'passed_win_set', playerId, value: null })
  emit(state, { type: 'turn_changed', playerId, lastDrawnTileId: tile.id })
  return true
}

function advanceAfterWin(state: GameState, from: PlayerId): void {
  if (state.players.filter(player => player.hasWon).length >= 3) {
    finish(state, 'three_winners')
    return
  }
  const next = nextActivePlayer(state, from)
  if (next === null) {
    finish(state, 'three_winners')
    return
  }
  state.kongContext = null
  draw(state, next, false)
}

function transfer(
  state: GameState,
  from: PlayerId,
  to: PlayerId,
  amount: number,
  reason: ScoreReason,
  sourceEventSequence: number,
): void {
  if (from === to || amount <= 0)
    return
  state.players[from].score -= amount
  state.players[to].score += amount
  emit(state, { type: 'score_transferred', from, to, amount, reason, sourceEventSequence })
}

export function finish(state: GameState, reason: 'three_winners' | 'wall_empty'): void {
  if (state.phase === 'finished')
    return
  state.responseWindow = null
  const started = emit(state, { type: 'final_settlement_started' })
  const settlement = settleFinal(state, started.sequence)
  for (const payment of [...settlement.refunds, ...settlement.flowerPigPayments, ...settlement.readyPayments])
    transfer(state, payment.from, payment.to, payment.amount, payment.reason, payment.sourceEventSequence)
  emit(state, { type: 'final_settlement_completed' })
  state.phase = 'finished'
  state.endReason = reason
  emit(state, { type: 'game_finished', reason })
}

interface HuOption {
  score: NonNullable<ReturnType<typeof calculateScore>>
  special: SpecialWinKind[]
}

function selfDrawOption(state: GameState, playerId: PlayerId): HuOption | null {
  const player = state.players[playerId]
  if (player.hand.some(tile => tile.type === player.dingque))
    return null
  const special: SpecialWinKind[] = ['selfDraw']
  if (state.lastDrawWasReplacement)
    special.push('kongDraw')
  if (state.lastDrawWasLastTile)
    special.push('lastTileDraw')
  const score = calculateScore(player.hand, {
    melds: player.melds,
    dingque: player.dingque,
    specialFan: special.length,
  })
  return score === null ? null : { score, special }
}

function responseHuOption(state: GameState, playerId: PlayerId, window: ResponseWindow): HuOption | null {
  const player = state.players[playerId]
  const special: SpecialWinKind[] = []
  if (window.kind === 'buGang')
    special.push('robKong')
  if (window.isLastTile)
    special.push('lastTileDiscard')
  if (window.isKongDiscard)
    special.push('kongDiscard')
  const score = calculateScore([...player.hand, window.tile], {
    melds: player.melds,
    dingque: player.dingque,
    specialFan: special.length,
  })
  if (score === null || (player.passedWinValue !== null && score.points <= player.passedWinValue))
    return null
  return { score, special }
}

function gangTypes(player: PlayerState): Map<string, TileInstance[]> {
  const groups = new Map<string, TileInstance[]>()
  for (const tile of player.hand) {
    const key = `${tile.type}-${tile.value}`
    groups.set(key, [...(groups.get(key) ?? []), tile])
  }
  return groups
}

function discardingActions(state: GameState, playerId: PlayerId): LegalAction[] {
  if (state.currentPlayer !== playerId || state.players[playerId].hasWon)
    return []
  const player = state.players[playerId]
  const actions: LegalAction[] = getLegalDiscards(player.hand, player.dingque)
    .map(tile => ({ type: 'discard', tileId: tile.id }))
  const hu = selfDrawOption(state, playerId)
  if (hu !== null && state.lastDrawnTileId !== null)
    actions.push({ type: 'hu', tileId: state.lastDrawnTileId, value: hu.score.points })

  for (const tiles of gangTypes(player).values()) {
    if (tiles.length === 4) {
      for (const tile of tiles)
        actions.push({ type: 'gang', tileId: tile.id, kind: 'anGang' })
    }
  }
  for (const meld of player.melds) {
    if (meld.kind !== 'peng')
      continue
    for (const tile of player.hand.filter(handTile => sameTile(handTile, meld.tiles[0])))
      actions.push({ type: 'gang', tileId: tile.id, kind: 'buGang' })
  }
  return actions
}

function responseActions(state: GameState, playerId: PlayerId): LegalAction[] {
  const window = state.responseWindow
  if (window === null || !window.eligiblePlayers.includes(playerId) || window.choices[playerId] !== undefined)
    return []
  const player = state.players[playerId]
  const matching = player.hand.filter(tile => sameTile(tile, window.tile))
  const actions: LegalAction[] = [{ type: 'pass' }]
  const hu = responseHuOption(state, playerId, window)
  if (hu !== null)
    actions.unshift({ type: 'hu', tileId: window.tile.id, value: hu.score.points })
  if (window.kind === 'discard') {
    if (matching.length >= 2)
      actions.push({ type: 'peng', tileId: window.tile.id })
    if (matching.length >= 3)
      actions.push({ type: 'gang', tileId: window.tile.id, kind: 'mingGang' })
  }
  return actions
}

export function getLegalActions(state: GameState, playerId: PlayerId): LegalAction[] {
  if (state.phase === 'finished')
    return []
  if (state.phase === 'dingque') {
    if (state.players[playerId].dingque !== null)
      return []
    return MILESTONE_1_RULES.tileTypes.map(tileType => ({ type: 'dingque', tileType }))
  }
  if (state.phase === 'discarding')
    return discardingActions(state, playerId)
  return responseActions(state, playerId)
}

function actionEquals(action: LegalAction, command: GameCommand): boolean {
  if (action.type !== command.type)
    return false
  switch (action.type) {
    case 'dingque': return command.type === 'dingque' && action.tileType === command.tileType
    case 'discard': return command.type === 'discard' && action.tileId === command.tileId
    case 'hu': return command.type === 'hu' && action.tileId === command.tileId && action.value === command.value
    case 'peng': return command.type === 'peng' && action.tileId === command.tileId
    case 'gang': return command.type === 'gang' && action.tileId === command.tileId && action.kind === command.kind
    case 'pass': return true
  }
}

function makeWindow(
  state: GameState,
  kind: 'discard' | 'buGang',
  sourcePlayer: PlayerId,
  tile: TileInstance,
  sourceEventSequence: number,
  pendingMeldIndex: number | null,
): ResponseWindow {
  return {
    kind,
    sourcePlayer,
    tile,
    eligiblePlayers: [],
    choices: {},
    resumePlayer: sourcePlayer,
    pendingMeldIndex,
    sourceEventSequence,
    isLastTile: state.lastDrawWasLastTile,
    isKongDiscard: kind === 'discard' && state.kongContext?.playerId === sourcePlayer && state.kongContext.awaitingDiscard,
  }
}

function openResponse(state: GameState, window: ResponseWindow): void {
  state.phase = 'responding'
  state.responseWindow = window
  window.eligiblePlayers = PLAYER_IDS.filter((playerId) => {
    if (playerId === window.sourcePlayer || state.players[playerId].hasWon)
      return false
    const temporary = { ...window, eligiblePlayers: [playerId] }
    state.responseWindow = temporary
    return responseActions(state, playerId).some(action => action.type !== 'pass')
  })
  state.responseWindow = window
  emit(state, { type: 'response_opened', window: structuredClone(window) })
  if (window.eligiblePlayers.length === 0)
    settleResponses(state)
}

function performMeld(state: GameState, playerId: PlayerId, kind: 'peng' | 'mingGang', window: ResponseWindow): Meld {
  const player = state.players[playerId]
  const needed = kind === 'peng' ? 2 : 3
  const matching = player.hand.filter(tile => sameTile(tile, window.tile)).slice(0, needed)
  const ids = new Set(matching.map(tile => tile.id))
  player.hand = player.hand.filter(tile => !ids.has(tile.id))
  const meld: Meld = { kind, tiles: [...matching, window.tile], fromPlayer: window.sourcePlayer }
  player.melds.push(meld)
  const source = state.players[window.sourcePlayer]
  source.discards = source.discards.filter(tile => tile.id !== window.tile.id)
  emit(state, { type: 'meld_declared', playerId, meld, replacedMeldIndex: null })
  return meld
}

function gainKongScore(state: GameState, playerId: PlayerId, payers: PlayerState[], amount: number, sourceSequence: number): number {
  for (const payer of payers)
    transfer(state, payer.id, playerId, amount, 'kong', sourceSequence)
  return payers.length * amount
}

function settleNoResponse(state: GameState, window: ResponseWindow): void {
  emit(state, { type: 'response_settled', outcome: 'none', actors: [] })
  state.responseWindow = null
  if (window.kind === 'buGang') {
    const player = state.players[window.sourcePlayer]
    const meldIndex = window.pendingMeldIndex!
    const oldMeld = player.melds[meldIndex]
    player.hand = player.hand.filter(tile => tile.id !== window.tile.id)
    const meld: Meld = { kind: 'buGang', tiles: [...oldMeld.tiles, window.tile], fromPlayer: oldMeld.fromPlayer }
    player.melds[meldIndex] = meld
    const event = emit(state, { type: 'meld_declared', playerId: player.id, meld, replacedMeldIndex: meldIndex })
    const gained = gainKongScore(state, player.id, activeOpponents(state, player.id), 1, event.sequence)
    state.kongContext = { playerId: player.id, gained, kongEventSequence: event.sequence, awaitingDiscard: true }
    draw(state, player.id, true)
    return
  }
  state.kongContext = null
  const next = nextActivePlayer(state, window.sourcePlayer)
  if (next === null)
    finish(state, 'three_winners')
  else
    draw(state, next, false)
}

function recordWin(state: GameState, playerId: PlayerId, option: HuOption, tile: TileInstance, fromPlayer: PlayerId | null, kind: WinInfo['kind']): void {
  const info: WinInfo = {
    tile,
    fromPlayer,
    kind,
    fan: option.score.scoringFan,
    points: option.score.points,
    special: option.special,
  }
  const player = state.players[playerId]
  player.hasWon = true
  player.winInfo = info
  emit(state, { type: 'player_won', playerId, info })
}

function settleHu(state: GameState, window: ResponseWindow, winners: PlayerId[]): void {
  emit(state, {
    type: 'response_settled',
    outcome: window.kind === 'buGang' ? 'robbedKong' : 'hu',
    actors: winners,
  })
  state.responseWindow = null

  for (const winner of winners) {
    const option = responseHuOption(state, winner, window)!
    recordWin(state, winner, option, window.tile, window.sourcePlayer, window.kind === 'buGang' ? 'robKong' : 'discard')
    transfer(state, window.sourcePlayer, winner, option.score.points, 'discard_win', window.sourceEventSequence)
    if (window.isKongDiscard && state.kongContext !== null && state.kongContext.playerId === window.sourcePlayer) {
      transfer(state, window.sourcePlayer, winner, state.kongContext.gained, 'call_transfer', state.kongContext.kongEventSequence)
    }
  }
  state.kongContext = null
  advanceAfterWin(state, window.sourcePlayer)
}

function settleResponses(state: GameState): void {
  const window = state.responseWindow!
  const huPlayers = window.eligiblePlayers.filter(playerId => window.choices[playerId]?.type === 'hu')
  if (huPlayers.length > 0) {
    settleHu(state, window, huPlayers)
    return
  }
  const byDistance = (a: PlayerId, b: PlayerId) => (a - window.sourcePlayer + 4) % 4 - (b - window.sourcePlayer + 4) % 4
  const gangPlayer = window.eligiblePlayers
    .filter(playerId => window.choices[playerId]?.type === 'gang')
    .sort(byDistance)[0]
  if (gangPlayer !== undefined) {
    emit(state, { type: 'response_settled', outcome: 'gang', actors: [gangPlayer] })
    state.responseWindow = null
    performMeld(state, gangPlayer, 'mingGang', window)
    const event = state.events[state.events.length - 1]
    const gained = gainKongScore(state, gangPlayer, [state.players[window.sourcePlayer]], 2, event.sequence)
    state.kongContext = { playerId: gangPlayer, gained, kongEventSequence: event.sequence, awaitingDiscard: true }
    draw(state, gangPlayer, true)
    return
  }
  const pengPlayer = window.eligiblePlayers
    .filter(playerId => window.choices[playerId]?.type === 'peng')
    .sort(byDistance)[0]
  if (pengPlayer !== undefined) {
    emit(state, { type: 'response_settled', outcome: 'peng', actors: [pengPlayer] })
    state.responseWindow = null
    performMeld(state, pengPlayer, 'peng', window)
    state.currentPlayer = pengPlayer
    state.phase = 'discarding'
    state.lastDrawnTileId = null
    state.lastDrawWasReplacement = false
    state.lastDrawWasLastTile = false
    state.kongContext = null
    emit(state, { type: 'turn_changed', playerId: pengPlayer, lastDrawnTileId: null })
    return
  }
  settleNoResponse(state, window)
}

function executeDingque(state: GameState, command: Extract<GameCommand, { type: 'dingque' }>): void {
  state.players[command.playerId].dingque = command.tileType
  emit(state, { type: 'dingque_selected', playerId: command.playerId, tileType: command.tileType })
  if (state.players.every(player => player.dingque !== null)) {
    state.phase = 'discarding'
    state.currentPlayer = state.dealer
    emit(state, { type: 'turn_changed', playerId: state.dealer, lastDrawnTileId: state.lastDrawnTileId })
  }
}

function executeDiscard(state: GameState, command: Extract<GameCommand, { type: 'discard' }>): void {
  const player = state.players[command.playerId]
  const tile = player.hand.find(candidate => candidate.id === command.tileId)!
  player.hand = player.hand.filter(candidate => candidate.id !== command.tileId)
  player.discards.push(tile)
  const event = emit(state, { type: 'tile_discarded', playerId: command.playerId, tile })
  const window = makeWindow(state, 'discard', command.playerId, tile, event.sequence, null)
  openResponse(state, window)
}

function executeSelfDraw(state: GameState, command: Extract<GameCommand, { type: 'hu' }>): void {
  const option = selfDrawOption(state, command.playerId)!
  const tile = state.players[command.playerId].hand.find(candidate => candidate.id === command.tileId)!
  recordWin(state, command.playerId, option, tile, null, 'selfDraw')
  const winSequence = state.events[state.events.length - 1].sequence
  for (const payer of activeOpponents(state, command.playerId))
    transfer(state, payer.id, command.playerId, option.score.points, 'self_draw', winSequence)
  advanceAfterWin(state, command.playerId)
}

function executeAnGang(state: GameState, command: Extract<GameCommand, { type: 'gang' }>): void {
  const player = state.players[command.playerId]
  const selected = player.hand.find(tile => tile.id === command.tileId)!
  const tiles = player.hand.filter(tile => sameTile(tile, selected))
  const ids = new Set(tiles.map(tile => tile.id))
  player.hand = player.hand.filter(tile => !ids.has(tile.id))
  const meld: Meld = { kind: 'anGang', tiles, fromPlayer: null }
  player.melds.push(meld)
  const event = emit(state, { type: 'meld_declared', playerId: player.id, meld, replacedMeldIndex: null })
  const gained = gainKongScore(state, player.id, activeOpponents(state, player.id), 2, event.sequence)
  state.kongContext = { playerId: player.id, gained, kongEventSequence: event.sequence, awaitingDiscard: true }
  draw(state, player.id, true)
}

function executeBuGang(state: GameState, command: Extract<GameCommand, { type: 'gang' }>): void {
  const player = state.players[command.playerId]
  const tile = player.hand.find(candidate => candidate.id === command.tileId)!
  const meldIndex = player.melds.findIndex(meld => meld.kind === 'peng' && sameTile(meld.tiles[0], tile))
  const sourceSequence = state.events.length === 0 ? 0 : state.events[state.events.length - 1].sequence
  const window = makeWindow(state, 'buGang', command.playerId, tile, sourceSequence, meldIndex)
  window.isLastTile = false
  window.isKongDiscard = false
  openResponse(state, window)
}

function executeResponse(state: GameState, command: Exclude<GameCommand, { type: 'dingque' | 'discard' }>): void {
  const window = state.responseWindow!
  let choice: ResponseChoice
  if (command.type === 'hu')
    choice = { type: 'hu', value: command.value }
  else if (command.type === 'gang')
    choice = { type: 'gang' }
  else
    choice = { type: command.type }
  window.choices[command.playerId] = choice
  emit(state, { type: 'response_chosen', playerId: command.playerId, choice })
  if (choice.type === 'pass') {
    const hu = responseHuOption(state, command.playerId, window)
    if (hu !== null) {
      state.players[command.playerId].passedWinValue = hu.score.points
      emit(state, { type: 'passed_win_set', playerId: command.playerId, value: hu.score.points })
    }
  }
  if (window.eligiblePlayers.every(playerId => window.choices[playerId] !== undefined))
    settleResponses(state)
}

export function getTimeoutCommand(state: GameState, playerId: PlayerId): GameCommand | null {
  const legal = getLegalActions(state, playerId)
  if (state.phase === 'dingque') {
    const tileType = recommendDingque(state.players[playerId].hand)
    const action = legal.find(candidate => candidate.type === 'dingque' && candidate.tileType === tileType)
    return action === undefined ? null : { ...action, playerId }
  }
  if (state.phase === 'responding') {
    const action = legal.find(candidate => candidate.type === 'pass')
    return action === undefined ? null : { ...action, playerId }
  }
  if (state.phase === 'discarding') {
    const player = state.players[playerId]
    const tile = chooseTimeoutDiscard(player.hand, player.dingque, state.lastDrawnTileId)
    const action = tile === null
      ? undefined
      : legal.find(candidate => candidate.type === 'discard' && candidate.tileId === tile.id)
    return action === undefined ? null : { ...action, playerId }
  }
  return null
}

export function executeCommand(state: GameState, command: GameCommand): CommandResult {
  const legal = getLegalActions(state, command.playerId)
  if (!legal.some(action => actionEquals(action, command)))
    return { ok: false, state, error: '非法动作', events: [] }

  const nextState = cloneState(state)
  const eventStart = nextState.events.length
  if (command.type === 'dingque')
    executeDingque(nextState, command)
  else if (nextState.phase === 'responding' && ['hu', 'peng', 'gang', 'pass'].includes(command.type))
    executeResponse(nextState, command as Exclude<GameCommand, { type: 'dingque' | 'discard' }>)
  else if (command.type === 'discard')
    executeDiscard(nextState, command)
  else if (command.type === 'hu')
    executeSelfDraw(nextState, command)
  else if (command.type === 'gang' && command.kind === 'anGang')
    executeAnGang(nextState, command)
  else if (command.type === 'gang' && command.kind === 'buGang')
    executeBuGang(nextState, command)

  const commandEvents = nextState.events.slice(eventStart)
  if (commandEvents.length > 0) {
    const { events: _, nextEventSequence: __, ...snapshot } = nextState
    commandEvents[commandEvents.length - 1].state = structuredClone(snapshot)
  }
  return { ok: true, nextState, events: commandEvents }
}
