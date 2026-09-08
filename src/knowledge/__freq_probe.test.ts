// 临时探针：统计实战对局中每条规则的触发频率（跑完即删）
import { describe, it } from 'vitest'
import type { PlayerId } from '../game/types'
import { createInitialGame } from '../game/core'
import { chooseAICommand } from '../game/ai'
import { executeCommand } from '../game/engine'
import { buildXiaoshiAdvice } from './xiaoshiAdvisor'

describe('规则触发频率探针', () => {
  it('统计 20 局', () => {
    const freq: Record<string, number> = {}
    let defaultTotal = 0
    let steps = 0
    let turnsWithAdvice = 0
    const defaultDist: Record<number, number> = {}
    for (let seed = 1; seed <= 20; seed++) {
      let state = createInitialGame(seed * 7919)
      for (let step = 0; step < 4000 && state.phase !== 'finished'; step++) {
        steps++
        const advice = buildXiaoshiAdvice(state, 0, { maxDecision: 20, maxObserve: 20 })
        const defaultAdvice = buildXiaoshiAdvice(state, 0)
        defaultDist[defaultAdvice.length] = (defaultDist[defaultAdvice.length] ?? 0) + 1
        defaultTotal += defaultAdvice.length
        if (advice.length > 0)
          turnsWithAdvice++
        for (const a of advice) freq[a.ruleId] = (freq[a.ruleId] ?? 0) + 1
        let pid: PlayerId | undefined
        if (state.phase === 'dingque')
          pid = ([0, 1, 2, 3] as PlayerId[]).find(id => state.players[id].dingque === null)
        else if (state.phase === 'responding')
          pid = state.responseWindow?.eligiblePlayers.find(id => state.responseWindow?.choices[id] === undefined)
        else
          pid = state.currentPlayer
        if (pid === undefined)
          break
        const cmd = chooseAICommand(state, pid)
        if (cmd === null)
          break
        const r = executeCommand(state, cmd)
        if (!r.ok)
          break
        state = r.nextState
      }
    }
    const rows = Object.entries(freq).sort((a, b) => b[1] - a[1])
    console.log(`\n总步数 ${steps} | 有建议的步数 ${turnsWithAdvice} (${(turnsWithAdvice / steps * 100).toFixed(1)}%)`)
    console.log(`默认限流建议总条数 ${defaultTotal} | 平均 ${(defaultTotal / steps).toFixed(2)} 条/步`)
    console.log('默认限流分布：', Object.entries(defaultDist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([n, count]) => `${n}条=${count}步`).join('，'))
    for (const [id, n] of rows) {
      console.log(`${id.padEnd(34)} ${String(n).padStart(5)}  ${(n / steps * 100).toFixed(2)}%`)
    }
    console.log('未触发规则：', [
      'R-RIVER-INFER-v0', 'R-DROP-CALL-v0', 'R-REBUILD-HAND-FROM-MELDS-v0', 'R-READ-BIG-DANDIAO-v0',
      'R-INFO-TWO-COLLECT-v0', 'R-DEPTH-JUDGE-v0', 'R-NOREACTION-INFO-v0', 'R-ENUM-PROB-CHOICE-v0',
      'R-FUTURE-WAIT-DEAD-v0', 'R-INFER-BEFORE-PONG-v0', 'R-ESCAPE-AVOID-BIG-v0', 'R-ESCAPE-SWITCH-SUIT-v0',
      'R-SET-BOTTOM-LINE-v0', 'R-EARLY-SAFE-DISCARD-v0',
    ].filter(id => freq[id] === undefined).join(', ') || '（无）')
  })
})
