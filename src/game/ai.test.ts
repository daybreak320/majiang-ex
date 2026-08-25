import type { TileType } from '../types'
import type { AIStyle, GameCommand, GameState, PlayerId, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { advanceAIOnce, buildAIView, chooseAICommand, getAIReason, runAIGame } from './ai'
import { createInitialGame, createTileSet, recommendDingque, sortTiles } from './core'
import { executeCommand, getLegalActions } from './engine'

function take(pool: TileInstance[], specification: string): TileInstance[] {
  if (specification.trim() === '')
    return []
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map((character) => {
      const index = pool.findIndex(tile => tile.type === type && tile.value === Number(character))
      if (index < 0)
        throw new Error(`夹具缺少 ${character}${type}`)
      return pool.splice(index, 1)[0]
    })
  })
}

function fixture(hands: [string, string, string, string], currentPlayer: PlayerId = 0): GameState {
  const pool = createTileSet()
  const state = createInitialGame(1)
  state.phase = 'discarding'
  state.currentPlayer = currentPlayer
  state.dealer = 0
  state.events = []
  state.nextEventSequence = 1
  state.responseWindow = null
  state.kongContext = null
  state.endReason = null
  state.lastDrawnTileId = null
  state.lastDrawWasReplacement = false
  state.lastDrawWasLastTile = false
  for (const player of state.players) {
    player.hand = sortTiles(take(pool, hands[player.id]))
    player.discards = []
    player.melds = []
    player.score = 0
    player.dingque = player.id % 2 === 0 ? '筒' : '条'
    player.hasWon = false
    player.winInfo = null
    player.passedWinValue = null
  }
  state.wall = pool
  return state
}

function actionIsLegal(state: GameState, command: GameCommand): boolean {
  const { playerId: _, ...action } = command
  return getLegalActions(state, command.playerId).some(candidate => JSON.stringify(candidate) === JSON.stringify(action))
}

function setStyle(state: GameState, playerId: PlayerId, style: AIStyle): void {
  state.players[playerId].aiStyle = style
}

function run(state: GameState, command: GameCommand): GameState {
  const result = executeCommand(state, command)
  if (!result.ok)
    throw new Error(result.error)
  return result.nextState
}

function entityIds(state: GameState): string[] {
  return [
    ...state.wall,
    ...state.players.flatMap(player => [
      ...player.hand,
      ...player.discards,
      ...player.melds.flatMap(meld => meld.tiles),
    ]),
  ].map(tile => tile.id)
}

describe('ai 可见信息与基础决策', () => {
  it('视图只包含自己的手牌和公开信息，不暴露对手手牌或牌墙', () => {
    const state = createInitialGame(960)
    const view = buildAIView(state, 1)
    expect(view.self.hand).toEqual(state.players[1].hand)
    expect(view.wallRemaining).toBe(state.wall.length)
    expect(view.players.every(player => !('hand' in player))).toBe(true)
    expect('wall' in view).toBe(false)
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(state.players[2].hand[0].id)
    expect(serialized).not.toContain(state.wall[0].id)
  })

  it('三种风格均只选择合法动作，且相同状态结果确定', () => {
    const base = fixture(['1万', '123456779万 12筒 123条', '2万', '3万'], 1)
    for (const style of ['efficient', 'aggressive', 'steady'] as const) {
      const state = structuredClone(base)
      setStyle(state, 1, style)
      const command = chooseAICommand(state, 1)!
      expect(actionIsLegal(state, command)).toBe(true)
      expect(chooseAICommand(state, 1)).toEqual(command)
      expect(getAIReason(state, 1, command).length).toBeGreaterThan(0)
    }
  })

  it('定缺严格使用推荐结果，强制定缺未清空时只弃缺门', () => {
    let state = createInitialGame(17)
    for (const playerId of [0, 1, 2, 3] as const) {
      const command = chooseAICommand(state, playerId)
      expect(command).toEqual({ type: 'dingque', tileType: recommendDingque(state.players[playerId].hand), playerId })
      state = run(state, command!)
    }

    const player = state.players[state.currentPlayer]
    if (!player.hand.some(tile => tile.type === player.dingque))
      player.dingque = player.hand[0].type
    const command = chooseAICommand(state, state.currentPlayer)!
    expect(command.type).toBe('discard')
    expect(player.hand.find(tile => tile.id === (command as Extract<GameCommand, { type: 'discard' }>).tileId)?.type).toBe(player.dingque)
  })

  it('所有风格遇到合法胡牌都必选胡', () => {
    const base = fixture(['9筒', '123万 456万 789万 111万 22万', '2万', '3万'], 1)
    base.players[1].dingque = '筒'
    base.lastDrawnTileId = base.players[1].hand[base.players[1].hand.length - 1].id
    for (const style of ['efficient', 'aggressive', 'steady'] as const) {
      const state = structuredClone(base)
      setStyle(state, 1, style)
      expect(chooseAICommand(state, 1)?.type).toBe('hu')
    }
  })

  it('稳定牌例中效率型保留连接、进攻型集中花色，稳健型依据公开信息避险', () => {
    const offense = fixture(['1筒', '1122334569万 123条 9条', '2筒', '3筒'], 1)
    offense.players[1].dingque = '筒'
    setStyle(offense, 1, 'efficient')
    const efficient = chooseAICommand(offense, 1) as Extract<GameCommand, { type: 'discard' }>
    setStyle(offense, 1, 'aggressive')
    const aggressive = chooseAICommand(offense, 1) as Extract<GameCommand, { type: 'discard' }>
    const efficientTile = offense.players[1].hand.find(tile => tile.id === efficient.tileId)!
    const aggressiveTile = offense.players[1].hand.find(tile => tile.id === aggressive.tileId)!
    expect(efficientTile).toMatchObject({ type: '万', value: 9 })
    expect(aggressiveTile).toMatchObject({ type: '条', value: 9 })
    expect(efficient.tileId).not.toBe(aggressive.tileId)

    const steady = structuredClone(offense)
    setStyle(steady, 1, 'steady')
    for (const opponent of steady.players.filter(player => player.id !== 1))
      opponent.dingque = '万'
    const beforePublicSafety = chooseAICommand(steady, 1) as Extract<GameCommand, { type: 'discard' }>
    for (const opponent of steady.players.filter(player => player.id !== 1))
      opponent.dingque = '条'
    const afterPublicSafety = chooseAICommand(steady, 1) as Extract<GameCommand, { type: 'discard' }>
    expect(steady.players[1].hand.find(tile => tile.id === beforePublicSafety.tileId)).toMatchObject({ type: '万', value: 9 })
    expect(steady.players[1].hand.find(tile => tile.id === afterPublicSafety.tileId)).toMatchObject({ type: '条', value: 9 })
  })

  it('响应命令始终合法，进攻型愿意碰而稳健型可选择过', () => {
    let state = fixture(['5万', '55万 123条 789筒', '1万', '2万'])
    const tile = state.players[0].hand[0]
    state = run(state, { type: 'discard', playerId: 0, tileId: tile.id })
    const aggressiveState = structuredClone(state)
    setStyle(aggressiveState, 1, 'aggressive')
    const aggressive = chooseAICommand(aggressiveState, 1)!
    expect(aggressive.type).toBe('peng')
    expect(actionIsLegal(aggressiveState, aggressive)).toBe(true)

    setStyle(state, 1, 'steady')
    const steady = chooseAICommand(state, 1)!
    expect(steady.type).toBe('pass')
    expect(actionIsLegal(state, steady)).toBe(true)
  })
})

describe('ai 机会数接入（朱扬《机会数理论与实战》落地）', () => {
  it('机会数参与决策：保留两头搭优于保留对子，即使对子结构分更高', () => {
    // 手牌：123456789万 55万 34条 4条（14 张，定缺筒）
    // - 打 3条 → 保留 44 对子：结构分 40，机会数 2（进 4条 成刻）
    // - 打 4条 → 保留 34 两头搭：结构分 39，机会数 8（进 2/5条）
    // 纯结构启发式会选打 3条；机会数权重纠正为打 4条（8 × 0.9 > 结构分差 1）
    const state = fixture(['9筒', '123456789万 55万 34条 4条', '2筒', '3筒'], 1)
    state.players[1].dingque = '筒'
    setStyle(state, 1, 'efficient')
    const command = chooseAICommand(state, 1) as Extract<GameCommand, { type: 'discard' }>
    const tile = state.players[1].hand.find(candidate => candidate.id === command.tileId)!
    expect(tile).toMatchObject({ type: '条', value: 4 })
  })

  it('出牌理由包含机会数与评级（可解释性）', () => {
    const state = fixture(['9筒', '123456789万 55万 34条 4条', '2筒', '3筒'], 1)
    state.players[1].dingque = '筒'
    setStyle(state, 1, 'efficient')
    const command = chooseAICommand(state, 1)!
    const reason = getAIReason(state, 1, command)
    expect(reason).toMatch(/机会数 \d+/)
    expect(reason).toMatch(/good/)
  })
})

describe('ai 自动推进与整局模拟', () => {
  it('单步推进不替玩家0行动，可依次推进 AI 定缺、弃牌和响应', () => {
    let state = createInitialGame(3)
    expect(advanceAIOnce(state).command?.playerId).toBe(1)
    state = advanceAIOnce(state).state
    expect(state.players[1].dingque).not.toBeNull()

    state = createInitialGame(4)
    for (const playerId of [0, 1, 2, 3] as const)
      state = run(state, chooseAICommand(state, playerId)!)
    if (state.currentPlayer === 0)
      expect(advanceAIOnce(state)).toEqual({ state, command: null })
    else
      expect(advanceAIOnce(state).command).toMatchObject({ playerId: state.currentPlayer, type: expect.stringMatching(/discard|hu|gang/) })

    state = fixture(['5万', '55万', '1万', '2万'])
    state = run(state, { type: 'discard', playerId: 0, tileId: state.players[0].hand[0].id })
    const advanced = advanceAIOnce(state)
    expect(advanced.command?.playerId).toBe(1)
    expect(advanced.state).not.toBe(state)

    const userTurn = fixture(['1万', '2万', '3万', '4万'])
    expect(advanceAIOnce(userTurn)).toEqual({ state: userTurn, command: null })
  })

  it('12 个固定 seed 均完整结束并保持事件、实体与分数不变量', () => {
    for (const seed of [1, 2, 3, 4, 5, 17, 42, 88, 96, 321, 960, 2026]) {
      const state = runAIGame(seed)
      expect(state.phase).toBe('finished')
      expect(['three_winners', 'wall_empty']).toContain(state.endReason)
      expect(state.events.map(event => event.sequence)).toEqual(state.events.map((_, index) => index + 1))
      const ids = entityIds(state)
      expect(ids).toHaveLength(108)
      expect(new Set(ids)).toHaveLength(108)
      expect(state.players.reduce((sum, player) => sum + player.score, 0)).toBe(0)
    }
  })

  it('模拟器在过低步数上限时抛出明确错误', () => {
    expect(() => runAIGame(1, 1)).toThrow('AI 对局超过最大步数 1（seed: 1）')
  })
})
