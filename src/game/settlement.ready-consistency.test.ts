import type { GameState, PlayerId } from './types'
import { describe, expect, it } from 'vitest'
import { chooseAICommand } from './ai'
import { createInitialGame } from './core'
import { executeCommand } from './engine'
import { analyzeReadyHand, isFlowerPig } from './settlement'

const PLAYER_IDS = [0, 1, 2, 3] as const

/**
 * 回归护栏：流局终局结算的「查叫」必须与 analyzeReadyHand 的判定一致。
 * 曾有用户反馈"我没下叫却看不到查叫扣分"，排查后确认引擎零误差，
 * 问题在结算页缺解释。此测试锁住引擎侧判定，避免日后重构悄悄漏算。
 */
describe('终局查叫 · 引擎判定一致性', () => {
  it('流局时「应有查叫」与「实际流水」完全一致', () => {
    let wallEmpty = 0
    let mismatch = 0
    const samples: string[] = []
    for (let seed = 1; seed <= 24; seed++) {
      let state: GameState = createInitialGame(seed, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
      for (let step = 0; step < 8000; step++) {
        if (state.phase === 'finished')
          break
        let playerId: PlayerId | undefined
        if (state.phase === 'dingque')
          playerId = PLAYER_IDS.find(id => state.players[id].dingque === null)
        else if (state.phase === 'responding')
          playerId = state.responseWindow?.eligiblePlayers.find(id => state.responseWindow?.choices[id] === undefined)
        else
          playerId = state.currentPlayer
        if (playerId === undefined)
          break
        const cmd = chooseAICommand(state, playerId)
        if (cmd === null)
          break
        const res = executeCommand(state, cmd)
        if (!res.ok)
          break
        state = res.nextState
      }
      if (state.endReason !== 'wall_empty')
        continue
      wallEmpty++
      const active = state.players.filter(player => !player.hasWon)
      const readyPlayers = active.filter(player => !isFlowerPig(player) && analyzeReadyHand(player).isReady)
      const notReady = active.filter(player => !analyzeReadyHand(player).isReady)
      const expectFlow = notReady.length > 0 && readyPlayers.length > 0
      const flows = state.events.filter(event => event.type === 'score_transferred' && event.reason === 'ready_compensation').length
      if (expectFlow !== (flows > 0)) {
        mismatch++
        if (samples.length < 6)
          samples.push(`seed=${seed} active=${active.length} ready=${readyPlayers.length} notReady=${notReady.length} flows=${flows}`)
      }
    }
    // 样本量护栏：确保这轮确实跑到了足够多的流局局数，否则断言会失去意义
    expect(wallEmpty).toBeGreaterThanOrEqual(8)
    expect(samples.join(' | ')).toBe('')
    expect(mismatch).toBe(0)
  })
})
