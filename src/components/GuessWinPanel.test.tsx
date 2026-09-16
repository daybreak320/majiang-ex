import type { TenpaiMemory } from '../game/guessWin'
import type { GameState, PlayerId } from '../game/types'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { chooseAICommand } from '../game/ai'
import { createInitialGame } from '../game/core'
import { executeCommand } from '../game/engine'
import { analyzeGuessWin, emptyTenpaiMemory, hasAnyTingPlayer, trackStateInto } from '../game/guessWin'
import { GuessWinPanel } from './GuessWinPanel'

const PLAYER_IDS = [0, 1, 2, 3] as const

/** 复刻 runAIGame 的推进逻辑（对所有玩家含人类玩家 0 都自动推演），首次出现听牌即截获 state。 */
function findTingState(): GameState | null {
  for (let seed = 20260915; seed < 20260915 + 80; seed++) {
    let state = createInitialGame(seed, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
    for (let step = 0; step < 2000; step++) {
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
      const command = chooseAICommand(state, playerId)
      if (command === null)
        break
      const result = executeCommand(state, command)
      if (!result.ok)
        break
      state = result.nextState
      if (hasAnyTingPlayer(state))
        return state
    }
  }
  return null
}

describe('guessWinPanel · 渲染验收', () => {
  it('听牌态下两路分区都渲染出真实内容且不崩溃', () => {
    const state = findTingState()
    expect(state, '应在若干种子内找到听牌态').not.toBeNull()
    const html = renderToString(<GuessWinPanel state={state!} />)
    // 面板标题与双路径标识
    expect(html).toContain('穷举收敛')
    expect(html).toContain('大胆猜测')
    // 路径一：至少出现一个具体叫口（如 “3万 ×2 · 12.5%” 或 “死叫”）
    expect(html).toMatch(/[1-9][万条筒]/)
    // 路径二：至少出现一条大胆猜测标签
    expect(html).toMatch(/(清一色|对对胡|七对|金钩钓|普通平胡|成牌规则反推)/)
    // 置信度徽标
    expect(html).toMatch(/(高可能|中可能|低可能)/)
    // 看推演：每张叫牌都应带一个可展开的拆牌按钮
    expect(html).toContain('看推演')
  })

  it('无人听牌时渲染空态，不崩溃', () => {
    const state = createInitialGame(20260915, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
    const html = renderToString(<GuessWinPanel state={state} />)
    expect(html).toContain('暂无玩家停牌')
    expect(html).toContain('穷举收敛')
    expect(html).toContain('大胆猜测')
  })

  it('听牌记忆：跨状态合并，听牌者 everTenpai 且保留 lastDetail', () => {
    const state = findTingState()
    expect(state, '应在若干种子内找到听牌态').not.toBeNull()
    let mem = emptyTenpaiMemory()
    mem = trackStateInto(mem, state!)
    for (const p of analyzeGuessWin(state!).players) {
      expect(mem[p.playerId]?.everTenpai).toBe(true)
      expect(mem[p.playerId]?.lastDetail).not.toBeNull()
    }
  })

  it('面板渲染记忆卡：已胡对手在无人当前听牌时也常驻展示', () => {
    const state = findTingState()
    expect(state, '应在若干种子内找到听牌态').not.toBeNull()
    const tenpaiPlayer = analyzeGuessWin(state!).players[0]
    // 记忆卡只展示对手（id !== 0），这里强制用非零 id，确保卡片被渲染。
    const familyId = tenpaiPlayer.playerId === 0 ? 1 : tenpaiPlayer.playerId
    const memory: TenpaiMemory = {
      [familyId]: { everTenpai: true, won: true, lastDetail: tenpaiPlayer, lastTenpai: false },
    }
    // 用一个全新的非听牌初始局面作为“当前 state”，验证记忆卡独立于实时听牌渲染。
    const fresh = createInitialGame(20260915, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
    const html = renderToString(<GuessWinPanel state={fresh} memory={memory} />)
    expect(html).toContain('已胡')
    expect(html).toContain('本局对手态势')
    expect(html).toContain('本局另有')
    expect(html).toContain('穷举收敛')
  })

  it('单钓玩家标注“仅此 1 张可胡”，避免误以为漏算', () => {
    let found = false
    for (let seed = 20260915; seed < 20260915 + 200 && !found; seed++) {
      let state = createInitialGame(seed, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
      for (let step = 0; step < 2000; step++) {
        if (state.phase === 'finished')
          break
        let pid: PlayerId | undefined
        if (state.phase === 'dingque')
          pid = PLAYER_IDS.find(id => state.players[id].dingque === null)
        else if (state.phase === 'responding')
          pid = state.responseWindow?.eligiblePlayers.find(id => state.responseWindow?.choices[id] === undefined)
        else
          pid = state.currentPlayer
        if (pid === undefined)
          break
        const command = chooseAICommand(state, pid)
        if (command === null)
          break
        const r = executeCommand(state, command)
        if (!r.ok)
          break
        state = r.nextState
        const result = analyzeGuessWin(state)
        if (result.players.some(p => p.waits.length === 1)) {
          const html = renderToString(<GuessWinPanel state={state} />)
          expect(html).toContain('单钓')
          expect(html).toContain('仅此 1 张可胡')
          found = true
          break
        }
      }
    }
    expect(found, '应在若干种子内找到含单钓听牌者的局面').toBe(true)
  })
})
