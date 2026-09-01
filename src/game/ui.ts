import type { GameCommand, GameState } from './types'

export function shouldWaitForUser(state: GameState): boolean {
  if (state.phase === 'finished')
    return true
  if (state.phase === 'dingque')
    return state.players[0].dingque === null
  if (state.phase === 'discarding')
    return state.currentPlayer === 0
  return state.responseWindow?.eligiblePlayers.includes(0) === true
    && state.responseWindow.choices[0] === undefined
}

export function shouldAdvanceAI(state: GameState): boolean {
  if (shouldWaitForUser(state))
    return false
  if (state.phase === 'dingque')
    return state.players.slice(1).some(player => player.dingque === null)
  if (state.phase === 'responding')
    return state.responseWindow?.eligiblePlayers.some(playerId => playerId !== 0 && state.responseWindow?.choices[playerId] === undefined) === true
  return state.phase === 'discarding' && state.currentPlayer !== 0
}

export function getTurnTimerDuration(state: GameState, timedTraining: boolean): number | null {
  if (!timedTraining)
    return null
  if (state.phase === 'discarding' && state.currentPlayer === 0)
    return 15
  if (state.phase === 'responding'
    && state.responseWindow?.eligiblePlayers.includes(0) === true
    && state.responseWindow.choices[0] === undefined) {
    return 8
  }
  return null
}

/** AI 思考仅按即将公开的动作和公开局势分层；上限 1.2 秒，不因暗手复杂度窥探或拉长。 */
export function getAIThinkingProfile(state: GameState, command: GameCommand): { delay: number, message: string } {
  const exposedOpponents = state.players.slice(1).filter(player => player.melds.length > 0 && !player.hasWon).length
  if (command.type === 'hu')
    return { delay: 1050, message: '准备胡牌…' }
  if (command.type === 'gang')
    return { delay: 980, message: '正在确认杠后节奏…' }
  if (command.type === 'peng')
    return { delay: 820, message: '正在权衡鸣牌提速…' }
  if (command.type === 'pass' && (state.wall.length <= 16 || exposedOpponents > 0))
    return { delay: 740, message: '正在权衡进攻与安全…' }
  if (command.type === 'discard' && (state.wall.length <= 16 || exposedOpponents >= 2))
    return { delay: 640, message: '正在核对安全退路…' }
  return { delay: 360, message: '思考中…' }
}
