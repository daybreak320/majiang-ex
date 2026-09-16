import type { Tile, TileType } from '../types'
import { describe, expect, it } from 'vitest'
import { isWinningHand } from '../game/scoring'
import { analyzeTingPatterns, countQiDuiQuads, getTingInfo } from './majiang'

// 万门牌速记：w([1,1,2]) → 一万、一万、二万
function w(values: number[], type: TileType = '万'): Tile[] {
  return values.map(value => ({ type, value }))
}

function values(tiles: Tile[]): string {
  return tiles.map(t => t.value).sort((a, b) => a - b).join('')
}

// 从 36 张同花色牌池里随机抽 n 张
function drawHand(type: TileType, n = 13): Tile[] {
  const pool: Tile[] = []
  for (let value = 1; value <= 9; value++) {
    for (let i = 0; i < 4; i++)
      pool.push({ type, value })
  }
  const hand: Tile[] = []
  for (let i = 0; i < n; i++)
    hand.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  return hand
}

describe('龙七对听牌判定（清一色训练判分回归）', () => {
  it('截图实测手牌：四张二万折两对，单钓 6万 应当判断为听牌', () => {
    // 玩家截图还原：1万1万 2万2万2万2万 3万3万 4万4万 6万 9万9万
    const hand = w([1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 6, 9, 9])
    expect(hand).toHaveLength(13)

    const ting = getTingInfo(hand)
    expect(ting.map(t => t.value)).toEqual([6])

    // 摸到 6万 → 1对1万 + 2对2万(四张折两对) + 1对3万 + 1对4万 + 1对6万 + 1对9万 = 7 对
    const winning = [...hand, { type: '万' as TileType, value: 6 }]
    expect(countQiDuiQuads(winning)).toBe(1)
    expect(isWinningHand(winning)).toBe(true)
  })

  it('龙七对拆解应给出七对结构（全部为对子）', () => {
    const hand = w([1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 6, 9, 9])
    const patterns = analyzeTingPatterns(hand, getTingInfo(hand))
    expect(patterns.length).toBeGreaterThan(0)
    expect(patterns.some(p => p.melds.every(m => m.kind === 'qiduiPair'))).toBe(true)
  })

  it('双龙七对：两组四张相同仍按七对成立', () => {
    const hand = w([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 9])
    expect(getTingInfo(hand).map(t => t.value)).toContain(9)
    expect(countQiDuiQuads([...hand, { type: '万' as TileType, value: 9 }])).toBe(2)
  })

  it('普通七对不受影响，且非七对牌型不会被误判', () => {
    // 1万1万 2万2万 3万3万 4万4万 5万5万 6万6万 + 9万 单钓 9万
    const qiDui = w([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 9])
    expect(getTingInfo(qiDui).map(t => t.value)).toEqual([9])

    // 张数为奇数、且存在单张的牌型不能算七对：1万1万2万3万4万5万6万7万8万9万9万 + 3万4万
    const notQiDui = w([1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9])
    expect(isWinningHand([...notQiDui, { type: '万' as TileType, value: 2 }])).toBe(
      getTingInfo(notQiDui).some(t => t.value === 2),
    )
  })
})

describe('听牌库自洽：与 game/scoring 的独立计番器交叉对拍', () => {
  it('随机单花色 13 张手牌，两套判定的可胡牌集合应完全一致', () => {
    const samples = 1500
    const mismatches: string[] = []

    for (let i = 0; i < samples; i++) {
      const hand = drawHand('万')
      const actual = new Set(getTingInfo(hand).map(t => t.value))
      const expected = new Set<number>()
      for (let value = 1; value <= 9; value++) {
        if (isWinningHand([...hand, { type: '万' as TileType, value }]))
          expected.add(value)
      }

      if (actual.size !== expected.size || [...expected].some(v => !actual.has(v))) {
        mismatches.push(
          `手牌 ${values(hand)} → 判分器[${[...actual].sort().join(',')}] vs 计番器[${[...expected].sort().join(',')}]`,
        )
      }
    }

    expect(
      mismatches,
      `发现 ${mismatches.length}/${samples} 手不一致：\n${mismatches.slice(0, 5).join('\n')}`,
    ).toEqual([])
  })
})
