import type { GameState, PlayerId } from '../game/types'
import { describe, it } from 'vitest'
import { chooseAICommand } from '../game/ai'
import { createInitialGame } from '../game/core'
import { executeCommand } from '../game/engine'
import { analyzeGuessWin } from '../game/guessWin'

const PLAYER_IDS = [0, 1, 2, 3] as const

describe('diag · 听牌识别 vs 胡牌', () => {
  it('统计：每个胡牌者在上一步是否已被识别为听牌', () => {
    let missed = 0
    let totalWins = 0
    let detectedCount = 0
    let tenpaiMoments = 0
    const seedsTested = 40
    for (let seed = 1; seed <= seedsTested; seed++) {
      let state: GameState = createInitialGame(seed, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
      let prevTenpai = new Set<PlayerId>()
      let prevWon = new Set<PlayerId>()
      for (let step = 0; step < 4000; step++) {
        if (state.phase === 'finished')
          break
        const detected = new Set(analyzeGuessWin(state).players.map(p => p.playerId))
        tenpaiMoments += detected.size
        const wonNow = new Set(state.players.filter(p => p.hasWon).map(p => p.id))
        for (const id of wonNow) {
          if (!prevWon.has(id)) {
            totalWins++
            if (prevTenpai.has(id)) {
              detectedCount++
            }
            else {
              missed++
              console.log(`[MISS] seed=${seed} step=${step} player ${id} 胡牌，但上一步未识别为听牌；上一步听牌集=${[...prevTenpai]} dingque=${state.players[id].dingque} melds=${state.players[id].melds.length}`)
            }
          }
        }
        let playerId: PlayerId | undefined
        if (state.phase === 'dingque')
          playerId = PLAYER_IDS.find(id => state.players[id].dingque === null)
        else if (state.phase === 'responding')
          playerId = state.responseWindow?.eligiblePlayers.find(id => state.responseWindow?.choices[id] === undefined)
        else
          playerId = state.currentPlayer
        if (playerId === undefined)
          break
        const command = chooseAICommand(state, playerId)
        if (command === null)
          break
        const result = executeCommand(state, command)
        if (!result.ok)
          break
        prevTenpai = detected
        prevWon = wonNow
        state = result.nextState
      }
    }
    console.log(`SUMMARY seeds=${seedsTested} totalWins=${totalWins} detectedPreWin=${detectedCount} missed=${missed} 累计听牌态出现次数=${tenpaiMoments}`)
  })
})
