import type { GameState } from './types'

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
