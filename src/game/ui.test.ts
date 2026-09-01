import { describe, expect, it } from 'vitest'
import { createInitialGame } from './core'
import { getAIThinkingProfile, getTurnTimerDuration, shouldAdvanceAI, shouldWaitForUser } from './ui'

describe('牌桌调度投影', () => {
  it('用户未定缺时等待，用户定缺后只推进一个待定缺 AI', () => {
    const state = createInitialGame(21)
    expect(shouldWaitForUser(state)).toBe(true)
    expect(shouldAdvanceAI(state)).toBe(false)

    state.players[0].dingque = '万'
    expect(shouldWaitForUser(state)).toBe(false)
    expect(shouldAdvanceAI(state)).toBe(true)
  })

  it('响应窗口优先等待未响应的用户，用户提交后再推进 AI', () => {
    const state = createInitialGame(22)
    state.phase = 'responding'
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 3,
      tile: state.players[3].hand[0],
      eligiblePlayers: [0, 1],
      choices: {},
      resumePlayer: 0,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    expect(shouldWaitForUser(state)).toBe(true)
    expect(shouldAdvanceAI(state)).toBe(false)

    state.responseWindow.choices[0] = { type: 'pass' }
    expect(shouldWaitForUser(state)).toBe(false)
    expect(shouldAdvanceAI(state)).toBe(true)
  })

  it('用户回合和结束状态都不会调度 AI', () => {
    const state = createInitialGame(23)
    state.phase = 'discarding'
    state.currentPlayer = 0
    expect(shouldAdvanceAI(state)).toBe(false)

    state.phase = 'finished'
    state.endReason = 'wall_empty'
    expect(shouldAdvanceAI(state)).toBe(false)
  })

  it('按公开动作和局势分层 AI 思考时间，且不超过 1.2 秒', () => {
    const state = createInitialGame(26)
    const discard = getAIThinkingProfile(state, { type: 'discard', playerId: 1, tileId: state.players[1].hand[0].id })
    const gang = getAIThinkingProfile(state, { type: 'gang', playerId: 1, kind: 'anGang', tileId: state.players[1].hand[0].id })
    const hu = getAIThinkingProfile(state, { type: 'hu', playerId: 1, tileId: state.players[1].hand[0].id, value: 1 })
    expect(discard).toMatchObject({ delay: 360, message: '思考中…' })
    expect(gang).toMatchObject({ delay: 980, message: '正在确认杠后节奏…' })
    expect(hu).toMatchObject({ delay: 1050, message: '准备胡牌…' })
    expect(Math.max(discard.delay, gang.delay, hu.delay)).toBeLessThanOrEqual(1200)
  })

  it('未开启计时训练时，用户出牌和响应窗口都不启动倒计时', () => {
    const state = createInitialGame(24)
    state.phase = 'discarding'
    state.currentPlayer = 0
    expect(getTurnTimerDuration(state, false)).toBeNull()

    state.phase = 'responding'
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 3,
      tile: state.players[3].hand[0],
      eligiblePlayers: [0],
      choices: {},
      resumePlayer: 0,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    expect(getTurnTimerDuration(state, false)).toBeNull()
  })

  it('开启计时训练后只计时用户决策窗口', () => {
    const state = createInitialGame(25)
    state.phase = 'discarding'
    state.currentPlayer = 0
    expect(getTurnTimerDuration(state, true)).toBe(15)

    state.currentPlayer = 2
    expect(getTurnTimerDuration(state, true)).toBeNull()

    state.phase = 'responding'
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 3,
      tile: state.players[3].hand[0],
      eligiblePlayers: [0, 1],
      choices: {},
      resumePlayer: 0,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    expect(getTurnTimerDuration(state, true)).toBe(8)

    state.responseWindow.choices[0] = { type: 'pass' }
    expect(getTurnTimerDuration(state, true)).toBeNull()
  })
})
