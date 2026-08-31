import type { TileType } from '../types'
import type { TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { getLegalActions } from './engine'
import { buildDiscardAssistant } from './assistant'
import {
  chooseTimeoutDiscard,
  createInitialGame,
  createSpecialTrainingGame,
  createSeededRandom,
  getWideBedScenario,
  createTileSet,
  getLegalDiscards,
  recommendDingque,
  shuffleTiles,
  sortTiles,
} from './core'

function tiles(specification: string): TileInstance[] {
  let id = 0
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map(value => ({ id: `test-${id++}`, type, value: Number(value) }))
  })
}

describe('牌组与开局', () => {
  it('创建万条筒 1-9 各四张且实体 id 唯一', () => {
    const set = createTileSet()
    expect(set).toHaveLength(108)
    expect(new Set(set.map(tile => tile.id))).toHaveLength(108)
    for (const type of ['万', '条', '筒'] as const) {
      for (let value = 1; value <= 9; value++)
        expect(set.filter(tile => tile.type === type && tile.value === value)).toHaveLength(4)
    }
  })

  it('相同 seed 产生相同洗牌和开局', () => {
    const set = createTileSet()
    expect(shuffleTiles(set, createSeededRandom(960))).toEqual(shuffleTiles(set, createSeededRandom(960)))
    expect(createInitialGame(960)).toEqual(createInitialGame(960))
  })

  it('发牌后保存完整可回放的初始状态', () => {
    const game = createInitialGame(42)
    expect(game.seed).toBe(42)
    expect(game.rulesVersion).toBe('m1.1')
    expect(game.wall).toHaveLength(55)
    expect(game.currentPlayer).toBe(game.dealer)
    expect(game.events).toEqual([])
    expect(game.players.map(player => player.hand.length)).toEqual(
      game.players.map(player => player.id === game.dealer ? 14 : 13),
    )
    expect(game.players.every(player => player.score === 0)).toBe(true)

    const allIds = [...game.wall, ...game.players.flatMap(player => player.hand)].map(tile => tile.id)
    expect(allIds).toHaveLength(108)
    expect(new Set(allIds)).toHaveLength(108)
    for (const player of game.players)
      expect(player.hand).toEqual(sortTiles(player.hand))
  })

  it('将三种 AI 风格确定性地分配给非用户座位', () => {
    const styles = createInitialGame(7).players.slice(1).map(player => player.aiStyle)
    expect(new Set(styles)).toEqual(new Set(['aggressive', 'steady', 'efficient']))
    expect(createInitialGame(7).players[0].aiStyle).toBeNull()
    expect(createInitialGame(7).players.slice(1).map(player => player.aiStyle)).toEqual(styles)
  })

  it('专项训练生成确定性局面，并保留完整且唯一的牌实体', () => {
    const game = createSpecialTrainingGame(88, 'endgame-count')
    expect(game.phase).toBe('discarding')
    expect(game.currentPlayer).toBe(0)
    expect(game.wall).toHaveLength(10)
    expect(game.players[0].hand).toHaveLength(14)
    const ids = [...game.wall, ...game.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)])].map(tile => tile.id)
    expect(ids).toHaveLength(108)
    expect(new Set(ids)).toHaveLength(108)
    expect(createSpecialTrainingGame(88, 'attack-qingyise')).toEqual(createSpecialTrainingGame(88, 'attack-qingyise'))
  })

  it('下宽叫专项轮换清一色与杠开残局，首巡均可比较不同宽度的叫口', () => {
    const qingyise = createSpecialTrainingGame(960, 'endgame-qingyise-tenpai')
    expect(qingyise.wall).toHaveLength(10)
    expect(qingyise.players[0].hand).toHaveLength(14)
    expect(qingyise.players[0].hand.every(tile => tile.type === '万')).toBe(true)
    expect(qingyise.players[0].dingque).not.toBe('万')
    const qingyiseCandidates = buildDiscardAssistant(qingyise, 0).candidates
    expect(qingyiseCandidates.some(candidate => candidate.nextDrawWinProbability !== null)).toBe(true)
    expect(new Set(qingyiseCandidates.filter(candidate => candidate.nextDrawWinProbability !== null).map(candidate => candidate.opportunity)).size).toBeGreaterThan(1)

    const kongDraw = createSpecialTrainingGame(961, 'endgame-qingyise-tenpai')
    expect(kongDraw.wall).toHaveLength(10)
    expect(kongDraw.players[0].melds).toHaveLength(4)
    expect(kongDraw.players[0].melds.every(meld => meld.kind === 'anGang')).toBe(true)
    expect(kongDraw.players[0].hand).toHaveLength(2)
    expect(buildDiscardAssistant(kongDraw, 0).candidates).toHaveLength(2)
    expect(createSpecialTrainingGame(960, 'endgame-qingyise-tenpai')).toEqual(qingyise)
  })

  it('金钩钓残局固定四副碰牌与两张候选，每次只需比较留哪张单吊', () => {
    const game = createSpecialTrainingGame(554512056, 'attack-jingoudiao')
    expect(game.players[0].melds).toHaveLength(4)
    expect(game.players[0].melds.every(meld => meld.kind === 'peng')).toBe(true)
    expect(game.players[0].hand).toHaveLength(2)
    expect(getLegalActions(game, 0).filter(action => action.type === 'discard')).toHaveLength(2)
    const candidates = buildDiscardAssistant(game, 0).candidates
    expect(candidates).toHaveLength(2)
    expect(new Set(candidates.map(candidate => candidate.opportunity)).size).toBeGreaterThan(1)
  })

  it('宽床四类分支从三家对手缺万的起手局开始，且不允许开局直接自摸胡', () => {
    expect(getWideBedScenario(0).route).toBe('清一色')
    expect(getWideBedScenario(1).route).toBe('七对自摸')
    expect(getWideBedScenario(2).route).toBe('普通自摸')
    expect(getWideBedScenario(3).route).toBe('素胡走人')
    for (const seed of [0, 1, 2, 3]) {
      const game = createSpecialTrainingGame(seed, 'attack-qingyise')
      const hu = getLegalActions(game, 0).find(action => action.type === 'hu')
      expect(hu, `宽床分支 ${seed} 不应起手天胡`).toBeUndefined()
    }
    const jingoudiao = createSpecialTrainingGame(554512056, 'attack-jingoudiao')
    expect(getLegalActions(jingoudiao, 0).find(action => action.type === 'hu')).toBeUndefined()
  })

  it('专项训练用固定公开牌河提供倾向证据，残局十张牌墙也可复现', () => {
    // 宽床训练从三家同缺刚完成后的第一巡开始：无人提前成型、副露或亮出牌河。
    for (const seed of [0, 1, 2, 3]) {
      const qingyise = createSpecialTrainingGame(seed, 'attack-qingyise')
      expect(qingyise.players[0].dingque).toBe('筒')
      expect(qingyise.players.slice(1).every(player => player.dingque === '万')).toBe(true)
      expect(qingyise.players.every(player => player.discards.length === 0)).toBe(true)
      expect(qingyise.players.every(player => player.melds.length === 0)).toBe(true)
      expect(qingyise.players[0].hand.some(tile => tile.type === '万')).toBe(true)
      expect(qingyise.players.slice(1).every(player => player.hand.every(tile => tile.type !== '万'))).toBe(true)
    }

    const bigHands = createSpecialTrainingGame(88, 'defense-big-hands')
    expect(bigHands.players[1].melds[0]?.tiles.map(tile => `${tile.value}${tile.type}`)).toEqual(['7条', '7条', '7条'])
    expect(bigHands.players[1].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['4条', '5条', '6条', '8条', '9条'])
    expect(bigHands.players[2].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['6筒', '7筒', '8筒', '9筒'])
    expect(bigHands.players[3].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['5万', '6万', '7万', '8万', '9万'])

    const race = createSpecialTrainingGame(88, 'defense-race-qingyise')
    expect(race.players[1].melds[0]?.tiles.map(tile => `${tile.value}${tile.type}`)).toEqual(['8条', '8条', '8条'])
    expect(race.players[1].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['4万', '5万', '6万', '8万', '9万'])
    expect(race.players[3].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['1万', '2万', '3万', '4万'])

    const endgame = createSpecialTrainingGame(88, 'endgame-count')
    expect(endgame.wall.map(tile => `${tile.value}${tile.type}`)).toEqual(['1条', '2条', '3条', '4条', '5条', '6条', '7条', '8条', '9条', '9筒'])
    expect(endgame.players.slice(1).flatMap(player => player.discards)).toHaveLength(45)
  })
})

describe('定缺与超时出牌', () => {
  it('有缺门牌时只能打缺门，清空后可打全部牌', () => {
    const hand = tiles('12万 34条 56筒')
    expect(getLegalDiscards(hand, '万').every(tile => tile.type === '万')).toBe(true)
    expect(getLegalDiscards(hand.filter(tile => tile.type !== '万'), '万')).toHaveLength(4)
  })

  it('推荐定缺确定且平局遵循固定花色顺序', () => {
    const hand = tiles('19万 19条 19筒')
    expect(recommendDingque(hand)).toBe('万')
    expect(recommendDingque(hand)).toBe(recommendDingque(hand))
  })

  it('同张数时优先移除结构更差的一门而非只数张数', () => {
    const hand = tiles('123万 159条 456筒')
    expect(recommendDingque(hand)).toBe('条')
  })

  it('摸到的牌合法时优先摸切', () => {
    const hand = tiles('123万 456条 789筒')
    const drawn = hand[hand.length - 1]
    expect(chooseTimeoutDiscard(hand, null, drawn.id)).toBe(drawn)
  })

  it('摸牌受定缺限制时打合法缺门牌且尽量保留对子', () => {
    const hand = tiles('1159万 234条 678筒')
    const drawn = hand.find(tile => tile.type === '条')!
    const discarded = chooseTimeoutDiscard(hand, '万', drawn.id)
    expect(discarded?.type).toBe('万')
    expect(discarded?.value).not.toBe(1)
  })
})
