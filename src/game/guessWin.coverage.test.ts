import { describe, it } from 'vitest'
import type { GameState, PlayerId } from '../game/types'
import { createInitialGame } from '../game/core'
import { chooseAICommand } from '../game/ai'
import { executeCommand } from '../game/engine'
import { analyzeGuessWin, emptyTenpaiMemory, trackStateInto } from '../game/guessWin'

const PLAYER_IDS = [0, 1, 2, 3] as const

describe('coverage · 听牌面板覆盖度', () => {
  it('统计同时听牌玩家数 / 叫口数分布 / 记忆 lastDetail 完整性', () => {
    const playerCountHist: Record<number, number> = {}
    const waitLenHist: Record<number, number> = {}
    let tingStep = 0
    let multiPlayer = 0
    let multiWait = 0
    let totalWon = 0
    let nullLastDetail = 0
    const seeds = 30
    for (let seed = 1; seed <= seeds; seed++) {
      let state: GameState = createInitialGame(seed, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
      let mem = emptyTenpaiMemory()
      for (let step = 0; step < 4000; step++) {
        if (state.phase === 'finished')
          break
        const result = analyzeGuessWin(state)
        if (result.players.length > 0) {
          tingStep++
          playerCountHist[result.players.length] = (playerCountHist[result.players.length] ?? 0) + 1
          if (result.players.length >= 2)
            multiPlayer++
          for (const p of result.players) {
            const wl = p.waits.length
            waitLenHist[wl] = (waitLenHist[wl] ?? 0) + 1
            if (wl >= 2)
              multiWait++
          }
        }
        mem = trackStateInto(mem, state)
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
        const r = executeCommand(state, command)
        if (!r.ok)
          break
        state = r.nextState
      }
      for (const p of state.players) {
        if (p.hasWon) {
          totalWon++
          if (mem[p.id]?.lastDetail == null)
            nullLastDetail++
        }
      }
    }
    console.log(`听牌态步数=${tingStep}  同时≥2家听牌步数=${multiPlayer}`)
    console.log(`同时听牌玩家数分布=${JSON.stringify(playerCountHist)}`)
    console.log(`每个听牌玩家叫口数分布=${JSON.stringify(waitLenHist)}  多叫口(≥2)出现次数=${multiWait}`)
    console.log(`已胡玩家总数=${totalWon}  其中末次细表(lastDetail)为null=${nullLastDetail}`)
  })
})
