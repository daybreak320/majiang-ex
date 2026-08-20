import type { Tile } from '../types'
// 朱扬麻将理论知识模块测试
import { describe, expect, it } from 'vitest'
import {
  brokenStrongCombos,
  classifyWaitShape,
  countOpportunities,
  gangBreaksStructure,
  isStrongCombo,
  lineOf,
  OPPORTUNITY_BASELINE,
  rateOpportunity,
  safetyScore,
  sameLine,
} from './mahjongTheory'

function tile(type: Tile['type'], value: number): Tile {
  return { type, value }
}

const WAN = '万'
const TIAO = '条'
const TONG = '筒'

describe('countOpportunities 机会数计算', () => {
  it('单吊：4 面子 + 单张，只听一张牌，机会数 = 3（对应书中"单吊的机会数是3"）', () => {
    const hand: Tile[] = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
      tile(TONG, 1),
      tile(TONG, 2),
      tile(TONG, 3),
      tile(TIAO, 5),
    ]
    // 4 面子（123/456/789万、123筒）+ 单吊 5条：进 5条 → 55条成将，胡
    const result = countOpportunities(hand)
    expect(result.total).toBe(3)
    expect(result.waits).toHaveLength(1)
    expect(result.waits[0].tile).toEqual(tile(TIAO, 5))
    expect(result.waits[0].remaining).toBe(3)
  })

  it('两头听：3 面子 + 将 + 顺搭，听 2 门各 4 张，机会数 = 8（对应"两头听最大 8"基准）', () => {
    const hand: Tile[] = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
      tile(TONG, 5),
      tile(TONG, 5),
      tile(TIAO, 3),
      tile(TIAO, 4),
    ]
    // 3 面子（123/456/789万）+ 55筒(将) + 34条(搭)：进 2条/5条 成顺，胡
    const result = countOpportunities(hand)
    expect(result.total).toBe(8)
    expect(result.waits.map(wait => wait.tile.value).sort()).toEqual([2, 5])
    expect(rateOpportunity(result.total)).toBe('good')
  })

  it('已见牌会扣减剩余张数', () => {
    const hand: Tile[] = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
      tile(TONG, 1),
      tile(TONG, 2),
      tile(TONG, 3),
      tile(TIAO, 5),
    ]
    const visible: Tile[] = [tile(TIAO, 5)]
    const result = countOpportunities(hand, visible)
    expect(result.waits[0].remaining).toBe(2)
    expect(result.total).toBe(2)
  })

  it('机会数 24 评级为 excellent（书中"听牌很容易"）', () => {
    expect(rateOpportunity(OPPORTUNITY_BASELINE.largeThreshold)).toBe('excellent')
  })

  it('定缺门：缺门花色不能参与胡牌，机会数计为 0', () => {
    const hand: Tile[] = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
      tile(TONG, 5),
      tile(TONG, 5),
      tile(TIAO, 3),
      tile(TIAO, 4),
    ]
    // 未定缺：55筒 可作将，进 2/5条 听牌 → 8
    expect(countOpportunities(hand).total).toBe(8)
    // 定缺筒：即使进 2/5条 成顺，手牌仍含缺门筒 → 不构成胡牌形 → 0
    expect(countOpportunities(hand, [], { dingque: TONG }).total).toBe(0)
    // 定缺条：进 2/5条 直接无效，也无其他进张 → 0
    expect(countOpportunities(hand, [], { dingque: TIAO }).total).toBe(0)
  })
})

describe('强组合（27/37/38）', () => {
  it('27/37/38 是强组合，其他组合不是', () => {
    expect(isStrongCombo(2, 7)).toBe(true)
    expect(isStrongCombo(3, 7)).toBe(true)
    expect(isStrongCombo(3, 8)).toBe(true)
    expect(isStrongCombo(2, 8)).toBe(true)
    expect(isStrongCombo(1, 4)).toBe(false)
    expect(isStrongCombo(4, 5)).toBe(false)
  })

  it('打掉某张后破坏强组合会被识别', () => {
    const hand: Tile[] = [tile(WAN, 2), tile(WAN, 7), tile(TIAO, 3), tile(TIAO, 8)]
    expect(brokenStrongCombos(hand, tile(WAN, 2))).toEqual([[2, 7]])
    expect(brokenStrongCombos(hand, tile(TIAO, 3))).toEqual([[3, 8]])
  })

  it('未包含强组合时返回空', () => {
    const hand: Tile[] = [tile(WAN, 1), tile(WAN, 4), tile(TIAO, 5), tile(TIAO, 6)]
    expect(brokenStrongCombos(hand, tile(WAN, 1))).toEqual([])
  })
})

describe('听牌形态分类', () => {
  it('两头听识别为 twoSided', () => {
    const waits = [
      { tile: tile(WAN, 5), remaining: 4 },
      { tile: tile(WAN, 6), remaining: 4 },
    ]
    expect(classifyWaitShape(waits)).toBe('twoSided')
  })

  it('三面以上识别为 threeSided', () => {
    const waits = [
      { tile: tile(WAN, 1), remaining: 4 },
      { tile: tile(WAN, 4), remaining: 4 },
      { tile: tile(WAN, 7), remaining: 4 },
    ]
    expect(classifyWaitShape(waits)).toBe('threeSided')
  })
})

describe('防守与安全', () => {
  it('踩线：1/4/7 同线、2/5/8 同线、3/6/9 同线', () => {
    expect(lineOf(1)).toBe(1)
    expect(lineOf(4)).toBe(1)
    expect(lineOf(7)).toBe(1)
    expect(lineOf(2)).toBe(2)
    expect(lineOf(8)).toBe(2)
    expect(lineOf(3)).toBe(3)
    expect(sameLine(4, 7)).toBe(true)
    expect(sameLine(4, 5)).toBe(false)
  })

  it('安全分：熟张最高，尾盘边张次之，1/4/7 线优于 3/6/9 线', () => {
    expect(safetyScore(4, true, false)).toBe(1)
    expect(safetyScore(9, false, true)).toBe(0.8)
    expect(safetyScore(7, false, false)).toBe(0.6)
    expect(safetyScore(5, false, false)).toBe(0.5)
    expect(safetyScore(3, false, false)).toBe(0.4)
  })
})

describe('杠牌不破坏牌型结构', () => {
  it('杠后剩余手牌数与目标结构不符 → 破坏', () => {
    // 1 副杠后还需 3 面子 + 1 将 = 11 张；只有 10 张 → 结构被破坏
    expect(gangBreaksStructure(10, 1)).toBe(true)
  })

  it('杠后手牌数匹配目标结构 → 不破坏', () => {
    expect(gangBreaksStructure(11, 1)).toBe(false)
  })
})
