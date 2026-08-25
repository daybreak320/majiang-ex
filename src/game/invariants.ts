import type { GameState, PlayerId } from './types'

const PLAYER_IDS: readonly PlayerId[] = [0, 1, 2, 3]

export interface InvariantViolation {
  code: string
  message: string
  path?: string
}

export interface InvariantReport {
  valid: boolean
  violations: InvariantViolation[]
}

function add(violations: InvariantViolation[], code: string, message: string, path?: string): void {
  violations.push({ code, message, path })
}

export function validateGameInvariants(state: GameState): InvariantReport {
  const violations: InvariantViolation[] = []
  const tiles = [
    ...state.wall,
    ...state.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)]),
  ]
  if (tiles.length !== 108)
    add(violations, 'tile_count', `牌张总数应为 108，实际为 ${tiles.length}`)

  const ids = new Set<string>()
  const names = new Map<string, number>()
  for (const tile of tiles) {
    if (ids.has(tile.id))
      add(violations, 'duplicate_tile_id', `牌实例 ID 重复：${tile.id}`, 'tiles')
    ids.add(tile.id)
    const name = `${tile.type}${tile.value}`
    const count = (names.get(name) ?? 0) + 1
    names.set(name, count)
    if (count > 4)
      add(violations, 'tile_copy_count', `同名牌 ${name} 超过 4 张`, 'tiles')
  }

  for (let index = 0; index < state.events.length; index++) {
    const expected = index + 1
    if (state.events[index].sequence !== expected)
      add(violations, 'event_sequence', `事件序号必须连续：期望 ${expected}，实际为 ${state.events[index].sequence}`, `events.${index}`)
  }
  if (state.nextEventSequence !== state.events.length + 1)
    add(violations, 'next_event_sequence', 'nextEventSequence 必须是最后事件序号加一', 'nextEventSequence')

  const scoreTotal = state.players.reduce((total, player) => total + player.score, 0)
  if (scoreTotal !== 0)
    add(violations, 'score_total', `玩家分数总和应为 0，实际为 ${scoreTotal}`, 'players')
  const transfers = state.events.filter((event): event is Extract<typeof event, { type: 'score_transferred' }> => event.type === 'score_transferred')
  for (const player of state.players) {
    const net = transfers.reduce((sum, transfer) =>
      sum + (transfer.to === player.id ? transfer.amount : 0) - (transfer.from === player.id ? transfer.amount : 0), 0)
    if (player.score !== net)
      add(violations, 'score_transfer_mismatch', `玩家 ${player.id} 分数 ${player.score} 与转账净额 ${net} 不一致`, `players.${player.id}.score`)
  }

  const wonPlayers = new Set<PlayerId>()
  for (const event of state.events) {
    if (event.type === 'player_won') {
      wonPlayers.add(event.playerId)
      continue
    }
    const actor = 'playerId' in event ? event.playerId : undefined
    if (actor !== undefined && wonPlayers.has(actor))
      add(violations, 'won_player_event', `已胡玩家 ${actor} 不能产生后续行动事件：${event.type}`, `events.${event.sequence}`)
  }

  if (state.phase === 'discarding' && state.players[state.currentPlayer].hasWon)
    add(violations, 'won_player_action', `已胡玩家 ${state.currentPlayer} 不能继续行动`, 'currentPlayer')
  const window = state.responseWindow
  if ((state.phase === 'responding') !== (window !== null))
    add(violations, 'response_phase', 'responding 阶段与 responseWindow 必须同时存在', 'responseWindow')
  if (window !== null) {
    if (state.players[window.sourcePlayer].hasWon)
      add(violations, 'won_response_source', `已胡玩家 ${window.sourcePlayer} 不能作为响应来源`, 'responseWindow.sourcePlayer')
    const eligible = new Set<PlayerId>()
    for (const playerId of window.eligiblePlayers) {
      if (!PLAYER_IDS.includes(playerId) || playerId === window.sourcePlayer)
        add(violations, 'response_eligible_player', `响应 eligible 玩家非法：${playerId}`, 'responseWindow.eligiblePlayers')
      if (eligible.has(playerId))
        add(violations, 'response_duplicate_player', `响应 eligible 玩家重复：${playerId}`, 'responseWindow.eligiblePlayers')
      if (state.players[playerId]?.hasWon)
        add(violations, 'won_response_player', `已胡玩家 ${playerId} 不能进入响应列表`, 'responseWindow.eligiblePlayers')
      eligible.add(playerId)
    }
    for (const [key, choice] of Object.entries(window.choices)) {
      const playerId = Number(key) as PlayerId
      if (!eligible.has(playerId))
        add(violations, 'response_choice_player', `玩家 ${playerId} 不在 eligible 中却存在响应 choice`, 'responseWindow.choices')
      if ((choice.type === 'peng' || choice.type === 'gang') && window.kind !== 'discard')
        add(violations, 'response_choice_kind', `${window.kind} 响应窗口不允许 ${choice.type}`, 'responseWindow.choices')
      if (choice.type === 'hu' && (!Number.isFinite(choice.value) || choice.value <= 0))
        add(violations, 'response_hu_value', `玩家 ${playerId} 的胡牌响应分值非法`, 'responseWindow.choices')
    }
  }
  const finished = state.events.some(event => event.type === 'game_finished')
  const settled = state.events.some(event => event.type === 'final_settlement_completed')
  if (state.phase === 'finished' && (!finished || !settled))
    add(violations, 'finished_events', 'finished 状态必须包含终局结算和结束事件')
  if (state.phase !== 'finished' && finished)
    add(violations, 'unfinished_game_event', '未 finished 状态不得包含 game_finished 事件')
  return { valid: violations.length === 0, violations }
}

export function assertGameInvariants(state: GameState): void {
  const report = validateGameInvariants(state)
  if (!report.valid)
    throw new Error(`牌局状态不变量失败：${report.violations[0].message}`)
}
