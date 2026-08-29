import type { TileType } from '../types'
import type { GameCommand, GameState, Meld, PlayerId, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { createInitialGame, createTileSet, sortTiles } from './core'
import { executeCommand, getLegalActions, getTimeoutCommand } from './engine'

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

function run(state: GameState, command: GameCommand): GameState {
  const result = executeCommand(state, command)
  if (!result.ok)
    throw new Error(result.error)
  return result.nextState
}

function action<T extends GameCommand['type']>(state: GameState, playerId: PlayerId, type: T) {
  return getLegalActions(state, playerId).find(candidate => candidate.type === type)
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

describe('统一命令与定缺', () => {
  it('初始化全部必填字段，非法命令不改输入，成功事件序号单调', () => {
    const initial = createInitialGame(960)
    expect(initial.players.every(player => player.winInfo === null && player.passedWinValue === null)).toBe(true)
    expect(initial).toMatchObject({ responseWindow: null, kongContext: null, endReason: null, nextEventSequence: 1 })

    const snapshot = structuredClone(initial)
    const illegal = executeCommand(initial, { type: 'discard', playerId: initial.dealer, tileId: initial.players[initial.dealer].hand[0].id })
    expect(illegal).toMatchObject({ ok: false, state: initial, events: [] })
    expect(initial).toEqual(snapshot)

    let state = initial
    for (const playerId of [0, 1, 2, 3] as const)
      state = run(state, { type: 'dingque', playerId, tileType: '万' })
    expect(state.phase).toBe('discarding')
    expect(state.currentPlayer).toBe(state.dealer)
    expect(state.events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(initial).toEqual(snapshot)
  })

  it('强制定缺，并提供三阶段纯 timeout 命令', () => {
    let state = createInitialGame(3)
    expect(getTimeoutCommand(state, 0)?.type).toBe('dingque')
    for (const playerId of [0, 1, 2, 3] as const)
      state = run(state, getTimeoutCommand(state, playerId)!)
    const dealer = state.dealer
    const timeout = getTimeoutCommand(state, dealer)
    expect(timeout?.type).toBe('discard')
    expect(getLegalActions(state, dealer)).toContainEqual(timeout && { type: timeout.type, tileId: 'tileId' in timeout ? timeout.tileId : '' })

    state = run(state, timeout!)
    for (const responder of state.responseWindow?.eligiblePlayers ?? [])
      expect(getTimeoutCommand(state, responder)).toEqual({ type: 'pass', playerId: responder })
  })
})

describe('弃牌响应与摸牌', () => {
  it('无人响应时跳过已胡玩家并从墙尾确定性摸牌，墙空则结束', () => {
    let state = fixture(['1万', '2万', '3万', '4万'])
    state.players[1].hasWon = true
    const expected = state.wall[state.wall.length - 1]
    state = run(state, { type: 'discard', playerId: 0, tileId: state.players[0].hand[0].id })
    expect(state.currentPlayer).toBe(2)
    expect(state.lastDrawnTileId).toBe(expected.id)
    expect(state.players[2].hand).toContainEqual(expected)

    state = fixture(['1万', '2万', '3万', '4万'])
    state.wall = []
    state = run(state, { type: 'discard', playerId: 0, tileId: state.players[0].hand[0].id })
    expect(state).toMatchObject({ phase: 'finished', endReason: 'wall_empty' })
  })

  it('碰会移动牌河实体并让响应者直接出牌', () => {
    let state = fixture(['5万', '55万', '1万', '2万'])
    state.players[1].dingque = '条'
    const discarded = state.players[0].hand[0]
    state = run(state, { type: 'discard', playerId: 0, tileId: discarded.id })
    state = run(state, { type: 'peng', playerId: 1, tileId: discarded.id })
    expect(state).toMatchObject({ phase: 'discarding', currentPlayer: 1, lastDrawnTileId: null })
    expect(state.players[0].discards).not.toContainEqual(discarded)
    expect(state.players[1].melds[0]).toMatchObject({ kind: 'peng', fromPlayer: 0 })
    expect(new Set(entityIds(state)).size).toBe(entityIds(state).length)
    expect(entityIds(state)).toHaveLength(108)
  })

  it('定缺未清时只允许过，不允许碰或明杠', () => {
    const state = fixture(['5万', '55万 1条', '1万', '2万'])
    state.players[1].dingque = '条'
    const discarded = state.players[0].hand[0]
    state.phase = 'responding'
    state.responseWindow = {
      kind: 'discard', sourcePlayer: 0, tile: discarded, eligiblePlayers: [1], choices: {},
      resumePlayer: 0, pendingMeldIndex: null, sourceEventSequence: 1, isLastTile: false, isKongDiscard: false,
    }

    expect(getLegalActions(state, 1)).toEqual([{ type: 'pass' }])
    expect(executeCommand(state, { type: 'peng', playerId: 1, tileId: discarded.id })).toMatchObject({ ok: false, error: '非法动作' })
  })

  it('明杠由点杠者支付2分并补摸', () => {
    let state = fixture(['5万', '555万', '1万', '2万'])
    const discarded = state.players[0].hand[0]
    state = run(state, { type: 'discard', playerId: 0, tileId: discarded.id })
    state = run(state, { type: 'gang', kind: 'mingGang', playerId: 1, tileId: discarded.id })
    expect(state.players.map(player => player.score)).toEqual([-2, 2, 0, 0])
    expect(state.players[1].melds[0].kind).toBe('mingGang')
    expect(state.lastDrawWasReplacement).toBe(true)
    expect(state.events).toContainEqual(expect.objectContaining({ type: 'score_transferred', from: 0, to: 1, amount: 2, reason: 'kong' }))
  })

  it('胡优先于碰且支持一炮多响，胡家退出，三家胡则结束', () => {
    let state = fixture([
      '5万',
      '123万 456万 123条 77条 46万',
      '55万',
      '12万',
    ])
    state.players[1].dingque = '筒'
    state.players[2].dingque = '条'
    state.players[3].hasWon = true
    const tile = state.players[0].hand[0]
    state = run(state, { type: 'discard', playerId: 0, tileId: tile.id })
    state = run(state, { type: 'hu', playerId: 1, tileId: tile.id, value: (action(state, 1, 'hu') as { value: number }).value })
    state = run(state, { type: 'peng', playerId: 2, tileId: tile.id })
    expect(state.players[1].hasWon).toBe(true)
    expect(state.players[2].hasWon).toBe(false)

    state = fixture([
      '5万',
      '123万 456万 123条 77条 46万',
      '123筒 456筒 789筒 77筒 46万',
      '12万',
    ])
    state.players[1].dingque = '筒'
    state.players[2].dingque = '条'
    state.players[3].hasWon = true
    const shared = state.players[0].hand[0]
    state = run(state, { type: 'discard', playerId: 0, tileId: shared.id })
    for (const winner of [1, 2] as const)
      state = run(state, { ...(action(state, winner, 'hu') as Extract<GameCommand, { type: 'hu' }>), playerId: winner })
    expect(state).toMatchObject({ phase: 'finished', endReason: 'three_winners' })
    expect(state.players[1].winInfo?.tile.id).toBe(shared.id)
    expect(state.players[2].winInfo?.tile.id).toBe(shared.id)
    expect(state.players[0].discards).toContainEqual(shared)
    expect(new Set(entityIds(state)).size).toBe(entityIds(state).length)
    expect(state.players.reduce((sum, player) => sum + player.score, 0)).toBe(0)
  })
})

describe('杠与胡牌计分', () => {
  it('暗杠每个未胡者付2分，补杠无人抢时每人付1分', () => {
    let state = fixture(['1111万', '2万', '3万', '4万'])
    state.players[3].hasWon = true
    const anGang = action(state, 0, 'gang') as Extract<GameCommand, { type: 'gang' }>
    state = run(state, { ...anGang, playerId: 0 })
    expect(state.players.map(player => player.score)).toEqual([4, -2, -2, 0])

    state = fixture(['4万', '2万', '3万', '5万'])
    const pengTiles = take(state.wall, '444万')
    const peng: Meld = { kind: 'peng', tiles: pengTiles, fromPlayer: 1 }
    state.players[0].melds = [peng]
    const buGang = getLegalActions(state, 0).find(candidate => candidate.type === 'gang' && candidate.kind === 'buGang')!
    state = run(state, { ...buGang, playerId: 0 })
    expect(state.players[0].melds[0].kind).toBe('buGang')
    expect(state.players.map(player => player.score)).toEqual([3, -1, -1, -1])
  })

  it('仅补杠可抢杠，被抢不成立不计杠分且加抢杠番', () => {
    let state = fixture([
      '9万',
      '123万 456万 123条 77条 78万',
      '2万',
      '3万',
    ])
    state.players[1].dingque = '筒'
    state.players[0].melds = [{ kind: 'peng', tiles: take(state.wall, '999万'), fromPlayer: 2 }]
    const tile = state.players[0].hand[0]
    state = run(state, { type: 'gang', kind: 'buGang', playerId: 0, tileId: tile.id })
    expect(state.responseWindow?.kind).toBe('buGang')
    state = run(state, { ...(action(state, 1, 'hu') as Extract<GameCommand, { type: 'hu' }>), playerId: 1 })
    expect(state.players[0].melds[0].kind).toBe('peng')
    expect(state.players[0].hand).toContainEqual(tile)
    expect(state.players[1].winInfo?.special).toContain('robKong')
    expect(state.events.filter(event => event.type === 'score_transferred' && event.reason === 'kong')).toHaveLength(0)
  })

  it('自摸由其余未胡者支付并叠加自摸、杠上花、海底番', () => {
    let state = fixture(['123万 456万 789万 111万 22万', '1条', '2条', '3条'])
    state.players[0].dingque = '筒'
    state.lastDrawnTileId = state.players[0].hand[state.players[0].hand.length - 1].id
    state.lastDrawWasReplacement = true
    state.lastDrawWasLastTile = true
    const hu = action(state, 0, 'hu') as Extract<GameCommand, { type: 'hu' }>
    state = run(state, { ...hu, playerId: 0 })
    expect(state.players[0].winInfo?.special).toEqual(['selfDraw', 'kongDraw', 'lastTileDraw'])
    expect(state.players[0].winInfo?.fan).toBe(5)
    expect(state.events.filter(event => event.type === 'score_transferred' && event.reason === 'self_draw')).toHaveLength(3)
    expect(state.players.reduce((sum, player) => sum + player.score, 0)).toBe(0)
  })

  it('过手胡限制同收益，严格更高可胡，自己摸牌解除', () => {
    let state = fixture(['5万', '123万 456万 123条 77条 46万', '55万', '2万'])
    state.players[1].dingque = '筒'
    state.players[3].hasWon = true
    const first = state.players[0].hand[0]
    state = run(state, { type: 'discard', playerId: 0, tileId: first.id })
    const value = (action(state, 1, 'hu') as { value: number }).value
    state = run(state, { type: 'pass', playerId: 1 })
    expect(state.players[1].passedWinValue).toBe(value)

    state.phase = 'responding'
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 2,
      tile: first,
      eligiblePlayers: [1],
      choices: {},
      resumePlayer: 2,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    expect(action(state, 1, 'hu')).toBeUndefined()
    state.responseWindow.isLastTile = true
    expect((action(state, 1, 'hu') as { value: number }).value).toBeGreaterThan(value)

    state.phase = 'discarding'
    state.responseWindow = null
    state.currentPlayer = 0
    state.players[1].hasWon = false
    state.players[0].hand = [take(state.wall, '9筒')[0]]
    state = run(state, { type: 'discard', playerId: 0, tileId: state.players[0].hand[0].id })
    expect(state.players[1].passedWinValue).toBeNull()
  })

  it('杠上炮呼叫转移按每位赢家完整杠收入支付且只影响紧接弃牌', () => {
    let state = fixture([
      '123万 456万 123条 77条 46万',
      '5万',
      '123筒 456筒 789筒 77筒 46万',
      '1万',
    ], 1)
    state.players[0].dingque = '筒'
    state.players[2].dingque = '条'
    state.kongContext = { playerId: 1, gained: 6, kongEventSequence: 8, awaitingDiscard: true }
    const tile = state.players[1].hand[0]
    state = run(state, { type: 'discard', playerId: 1, tileId: tile.id })
    for (const winner of [0, 2] as const)
      state = run(state, { ...(action(state, winner, 'hu') as Extract<GameCommand, { type: 'hu' }>), playerId: winner })
    const transfers = state.events.filter((event): event is Extract<typeof event, { type: 'score_transferred' }> =>
      event.type === 'score_transferred' && event.reason === 'call_transfer',
    )
    expect(transfers.map(event => event.amount)).toEqual([6, 6])
    expect(state.kongContext).toBeNull()
    expect(state.players.reduce((sum, player) => sum + player.score, 0)).toBe(0)
  })
})

describe('确定性回放', () => {
  it('同一初始状态和命令序列得到一致结果', () => {
    const play = () => {
      let state = createInitialGame(88)
      for (const playerId of [0, 1, 2, 3] as const)
        state = run(state, getTimeoutCommand(state, playerId)!)
      state = run(state, getTimeoutCommand(state, state.currentPlayer)!)
      for (const playerId of state.responseWindow?.eligiblePlayers ?? [])
        state = run(state, getTimeoutCommand(state, playerId)!)
      return state
    }
    expect(play()).toEqual(play())
  })
})
