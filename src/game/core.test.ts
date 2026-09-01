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
  getSpecialTrainingScenarioCount,
  getEndgameCountLibrarySeed,
  getJingoudiaoLibrarySeed,
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

  it('专项公开足量题组：下宽叫100局、最后十张500局', () => {
    expect(getSpecialTrainingScenarioCount('attack-qingyise')).toBe(6)
    expect(getSpecialTrainingScenarioCount('attack-jingoudiao')).toBe(100)
    expect(getSpecialTrainingScenarioCount('endgame-qingyise-tenpai')).toBe(100)
    expect(getSpecialTrainingScenarioCount('endgame-count')).toBe(500)
    for (const kind of ['defense-big-hands', 'defense-race-qingyise'] as const)
      expect(getSpecialTrainingScenarioCount(kind)).toBe(3)
  })

  it('清一色听牌题库按编号提供100个独立残局，且每题都保留十张牌墙', () => {
    const count = getSpecialTrainingScenarioCount('endgame-qingyise-tenpai')
    const signatures = Array.from({ length: count }, (_, index) => {
      const game = createSpecialTrainingGame(20260901, 'endgame-qingyise-tenpai', index)
      const ids = [...game.wall, ...game.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)])].map(tile => tile.id)
      expect(game.wall).toHaveLength(10)
      expect(ids).toHaveLength(108)
      expect(new Set(ids)).toHaveLength(108)
      expect(getLegalActions(game, 0).filter(action => action.type === 'discard').length).toBeGreaterThan(0)
      return `${game.players[0].hand.map(tile => `${tile.value}${tile.type}`).join(',')}|${game.players.slice(1).flatMap(player => player.discards).map(tile => `${tile.value}${tile.type}`).join(',')}|${game.wall.map(tile => `${tile.value}${tile.type}`).join(',')}`
    })
    expect(new Set(signatures)).toHaveLength(count)
  })

  it('500局残局仓库的编号与种子一一对应，首批题面均不重复', () => {
    const seeds = Array.from({ length: 500 }, (_, index) => getEndgameCountLibrarySeed(index))
    expect(new Set(seeds)).toHaveLength(500)
    const signatures = Array.from({ length: 500 }, (_, index) => {
      const game = createSpecialTrainingGame(1, 'endgame-count', index, true)
      const ids = [...game.wall, ...game.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)])].map(tile => tile.id)
      expect(game.wall).toHaveLength(10)
      expect(ids).toHaveLength(108)
      expect(new Set(ids)).toHaveLength(108)
      expect(getLegalActions(game, 0).filter(action => action.type === 'discard').length).toBeGreaterThan(0)
      return [
        game.players[0].hand.map(tile => `${tile.value}${tile.type}`).join(','),
        ...game.players.slice(1).map(player => player.discards.map(tile => `${tile.value}${tile.type}`).join(',')),
        game.wall.map(tile => `${tile.value}${tile.type}`).join(','),
      ].join('|')
    })
    expect(new Set(signatures)).toHaveLength(500)
  })

  it('最后十张专项按题库编号生成新残局，而非给固定模板换花色', () => {
    const first = createSpecialTrainingGame(20260901, 'endgame-count', 0, true)
    const second = createSpecialTrainingGame(20260902, 'endgame-count', 1, true)
    expect(first.players[0].hand.map(tile => `${tile.value}${tile.type}`)).not.toEqual(second.players[0].hand.map(tile => `${tile.value}${tile.type}`))
    expect(first.players.slice(1).flatMap(player => player.discards).map(tile => `${tile.value}${tile.type}`)).not.toEqual(second.players.slice(1).flatMap(player => player.discards).map(tile => `${tile.value}${tile.type}`))
    for (const game of [first, second]) {
      const ids = [...game.wall, ...game.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)])].map(tile => tile.id)
      expect(game.wall).toHaveLength(10)
      expect(game.players.slice(1).flatMap(player => player.discards)).toHaveLength(45)
      expect(ids).toHaveLength(108)
      expect(new Set(ids)).toHaveLength(108)
      expect(getLegalActions(game, 0).filter(action => action.type === 'discard').length).toBeGreaterThan(0)
    }
  })

  it('显式题组编号优先于随机 seed，确保入口题号与实际题面一致', () => {
    const first = createSpecialTrainingGame(998877, 'endgame-qingyise-tenpai', 0)
    const second = createSpecialTrainingGame(998877, 'endgame-qingyise-tenpai', 1)
    expect(first).not.toEqual(second)
    expect(createSpecialTrainingGame(998877, 'endgame-qingyise-tenpai', 0)).toEqual(first)
    expect(first.players[0].hand).toHaveLength(14)
    expect(first.wall).toHaveLength(10)
  })

  it('下宽叫专项的首巡保留两门实战手牌与十张残局信息', () => {
    const game = createSpecialTrainingGame(960, 'endgame-qingyise-tenpai', 18)
    expect(game.wall).toHaveLength(10)
    expect(game.players[0].hand).toHaveLength(14)
    expect(new Set(game.players[0].hand.map(tile => tile.type)).size).toBe(2)
    expect(game.players[0].dingque).not.toBeNull()
    expect(buildDiscardAssistant(game, 0).candidates.length).toBeGreaterThan(1)
  })

  it('金钩钓百局题库保留四副碰、两张候选、十张残局墙且题面不重复', () => {
    const count = getSpecialTrainingScenarioCount('attack-jingoudiao')
    expect(new Set(Array.from({ length: count }, (_, index) => getJingoudiaoLibrarySeed(index)))).toHaveLength(count)
    const signatures = Array.from({ length: count }, (_, index) => {
      const game = createSpecialTrainingGame(554512056, 'attack-jingoudiao', index)
      const ids = [...game.wall, ...game.players.flatMap(player => [...player.hand, ...player.discards, ...player.melds.flatMap(meld => meld.tiles)])].map(tile => tile.id)
      expect(game.wall).toHaveLength(10)
      expect(game.players[0].melds).toHaveLength(4)
      expect(game.players[0].melds.every(meld => meld.kind === 'peng')).toBe(true)
      expect(game.players[0].hand).toHaveLength(2)
      expect(ids).toHaveLength(108)
      expect(new Set(ids)).toHaveLength(108)
      expect(getLegalActions(game, 0).filter(action => action.type === 'discard')).toHaveLength(2)
      return [
        game.players[0].melds.flatMap(meld => meld.tiles).map(tile => `${tile.value}${tile.type}`).join(','),
        game.players[0].hand.map(tile => `${tile.value}${tile.type}`).join(','),
        ...game.players.slice(1).map(player => player.discards.map(tile => `${tile.value}${tile.type}`).join(',')),
        game.wall.map(tile => `${tile.value}${tile.type}`).join(','),
      ].join('|')
    })
    expect(new Set(signatures)).toHaveLength(count)
  })

  it('宽床四类分支从三家对手缺万的起手局开始，且不允许开局直接自摸胡', () => {
    expect(getWideBedScenario(0).route).toBe('清一色')
    expect(getWideBedScenario(1).route).toBe('七对自摸')
    expect(getWideBedScenario(2).route).toBe('普通自摸')
    expect(getWideBedScenario(3).route).toBe('素胡走人')
    expect(getWideBedScenario(4).route).toBe('清一色')
    expect(getWideBedScenario(5).route).toBe('普通自摸')
    expect(new Set([0, 1, 2, 3, 4, 5].map(seed => getWideBedScenario(seed).id))).toHaveLength(6)
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const game = createSpecialTrainingGame(seed, 'attack-qingyise')
      const hu = getLegalActions(game, 0).find(action => action.type === 'hu')
      expect(hu, `宽床分支 ${seed} 不应起手天胡`).toBeUndefined()
    }
    const jingoudiao = createSpecialTrainingGame(554512056, 'attack-jingoudiao')
    expect(getLegalActions(jingoudiao, 0).find(action => action.type === 'hu')).toBeUndefined()
  })

  it('专项训练用固定公开牌河提供倾向证据；最后十张永远走500局仓库', () => {
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

    const bigHandMelds = [0, 1, 2].map(seed => createSpecialTrainingGame(seed, 'defense-big-hands').players[1].melds[0]?.tiles.map(tile => `${tile.value}${tile.type}`))
    expect(bigHandMelds).toEqual([
      ['7条', '7条', '7条'],
      ['7筒', '7筒', '7筒'],
      ['7万', '7万', '7万'],
    ])
    const bigHands = createSpecialTrainingGame(1, 'defense-big-hands')
    expect(bigHands.players[1].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['4筒', '5筒', '6筒', '8筒', '9筒'])
    expect(bigHands.players[2].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['6条', '7条', '8条', '9条'])

    const raceMelds = [0, 1, 2].map(seed => createSpecialTrainingGame(seed, 'defense-race-qingyise').players[1].melds[0]?.tiles.map(tile => `${tile.value}${tile.type}`))
    expect(raceMelds).toEqual([
      ['8条', '8条', '8条'],
      ['8万', '8万', '8万'],
      ['8筒', '8筒', '8筒'],
    ])
    const race = createSpecialTrainingGame(1, 'defense-race-qingyise')
    expect(race.players[1].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['4条', '5条', '6条', '8条', '9条'])
    expect(race.players[3].discards.map(tile => `${tile.value}${tile.type}`)).toEqual(['1条', '2条', '3条', '4条'])

    const endgameGames = [0, 1, 2].map(index => createSpecialTrainingGame(index, 'endgame-count'))
    const endgameSignatures = endgameGames.map(game => [
      game.players[0].hand.map(tile => `${tile.value}${tile.type}`).join(','),
      ...game.players.slice(1).map(player => player.discards.map(tile => `${tile.value}${tile.type}`).join(',')),
      game.wall.map(tile => `${tile.value}${tile.type}`).join(','),
    ].join('|'))
    expect(new Set(endgameSignatures)).toHaveLength(3)
    expect(endgameGames.every(game => game.wall.length === 10)).toBe(true)
    expect(endgameGames.every(game => game.players.slice(1).flatMap(player => player.discards).length === 45)).toBe(true)
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
