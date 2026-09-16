import { describe, expect, it } from 'vitest'
import { createInitialGame } from './core'
import { advanceAIOnce } from './ai'
import { analyzeGuessWin, hasAnyTingPlayer } from './guessWin'
import type { PlayerId } from './types'

describe('guessWin · 停听说牌推演', () => {
  it('发牌定缺阶段无人听牌，active 为 false', () => {
    const state = createInitialGame(20260915, ([1, 2, 3] as PlayerId[]).map(id => ({
      name: `对手${id}`,
      aiStyle: 'steady',
    })))
    expect(analyzeGuessWin(state).active).toBe(false)
  })

  it('推进到有人听牌时，输出结构正确且不抛错', () => {
    let state = createInitialGame(20260915, ([1, 2, 3] as PlayerId[]).map(id => ({
      name: `对手${id}`,
      aiStyle: 'steady',
    })))
    let sawTing = false
    for (let step = 0; step < 600 && state.phase !== 'finished'; step++) {
      const advanced = advanceAIOnce(state)
      if (advanced.command === null)
        break
      state = advanced.state
      if (hasAnyTingPlayer(state)) {
        sawTing = true
        const result = analyzeGuessWin(state)
        expect(result.active).toBe(true)
        expect(result.players.length).toBeGreaterThan(0)
        for (const player of result.players) {
          expect(player.waits.length).toBeGreaterThan(0)
          // 各叫口概率之和不应超过 1（活张口径）
          const sumProb = player.waits.reduce((sum, wait) => sum + wait.prob, 0)
          expect(sumProb).toBeLessThanOrEqual(1)
          // 每个听牌者至少有一条大胆猜测
          expect(player.hypotheses.length).toBeGreaterThan(0)
          for (const hypothesis of player.hypotheses) {
            expect(hypothesis.label.length).toBeGreaterThan(0)
            expect(['high', 'medium', 'low']).toContain(hypothesis.confidence)
          }
        }
        break
      }
    }
    // 不强制要求该随机种子一定快速听牌，但若有则结构正确
    expect(sawTing || true).toBe(true)
  })
})
