import { describe, expect, it } from 'vitest'
import { JINGOUDIAO_LIBRARY_SIZE, createSpecialTrainingGame } from './core'

/**
 * 金钩钓专项是一道「比较哪张单吊更活」的选择题，题面必须自洽：
 * 1. 两张候选都必须留有活张，否则选哪张都胡不了，题目变成废题；
 * 2. 两张候选的活张数不能相同，否则题目没有唯一更优解。
 * 这里对整本题库逐题体检，防止生成器再次退化成“幽灵选项”。
 */
describe('金钩钓专项题库', () => {
  function candidateAliveCounts(index: number) {
    const state = createSpecialTrainingGame(0, 'attack-jingoudiao', index)
    const me = state.players[0]
    const seen: Record<string, number> = {}
    for (const player of state.players) {
      for (const tile of player.discards) {
        const key = `${tile.value}${tile.type}`
        seen[key] = (seen[key] ?? 0) + 1
      }
    }
    for (const meld of me.melds) {
      for (const tile of meld.tiles) {
        const key = `${tile.value}${tile.type}`
        seen[key] = (seen[key] ?? 0) + 1
      }
    }
    return me.hand.map((tile) => {
      const key = `${tile.value}${tile.type}`
      const mine = me.hand.filter(t => t.value === tile.value && t.type === tile.type).length
      return { key, alive: 4 - (seen[key] ?? 0) - mine }
    })
  }

  it('每张候选单吊都留有活张，不出现两张都胡不了的废题', () => {
    const dead: string[] = []
    for (let index = 0; index < JINGOUDIAO_LIBRARY_SIZE; index++) {
      const stats = candidateAliveCounts(index)
      if (stats.some(stat => stat.alive < 1))
        dead.push(`#${index} ${stats.map(stat => `${stat.key}(活${stat.alive})`).join(' ')}`)
    }
    expect(dead).toEqual([])
  })

  it('两张候选的活张数不同，题目具有唯一更优解', () => {
    const tied: string[] = []
    for (let index = 0; index < JINGOUDIAO_LIBRARY_SIZE; index++) {
      const stats = candidateAliveCounts(index)
      if (stats[0].alive === stats[1].alive)
        tied.push(`#${index} ${stats.map(stat => `${stat.key}(活${stat.alive})`).join(' ')}`)
    }
    expect(tied).toEqual([])
  })

  it('修补活张不破坏牌张配额：牌墙 10 张、三家牌河各 15 张、全牌 108 张无重复', () => {
    for (let index = 0; index < JINGOUDIAO_LIBRARY_SIZE; index++) {
      const state = createSpecialTrainingGame(0, 'attack-jingoudiao', index)
      expect(state.wall).toHaveLength(10)
      for (const playerId of [1, 2, 3] as const)
        expect(state.players[playerId].discards).toHaveLength(15)
      const ids = [
        ...state.wall,
        ...state.players.flatMap(player => [
          ...player.hand,
          ...player.discards,
          ...player.melds.flatMap(meld => meld.tiles),
        ]),
      ].map(tile => tile.id)
      expect(ids).toHaveLength(108)
      expect(new Set(ids).size).toBe(108)
    }
  })
})
