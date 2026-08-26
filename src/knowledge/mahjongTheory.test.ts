import type { Meld, TileInstance } from '../game/types'
import type { Tile } from '../types'
// 朱扬麻将理论知识模块测试
import { describe, expect, it } from 'vitest'
import {
  assessDiscardSafety,
  assessGangStructure,
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

let instanceId = 0
function instance(type: Tile['type'], value: number): TileInstance {
  return { id: `theory-${instanceId++}`, type, value }
}

function peng(type: Tile['type'], value: number): Meld {
  return {
    kind: 'peng',
    tiles: [instance(type, value), instance(type, value), instance(type, value)],
    fromPlayer: 1,
  }
}

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

  it('叫牌全部见完时仍保留结构叫口，但活张机会数为 0', () => {
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
    const visible = [tile(TIAO, 5), tile(TIAO, 5), tile(TIAO, 5)]
    const result = countOpportunities(hand, visible)
    expect(result.total).toBe(0)
    expect(result.waits).toHaveLength(0)
    expect(result.structuralWaits).toEqual([{ tile: tile(TIAO, 5), remaining: 0 }])
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

  it('一组副露后按 10 张暗手计算并分类两头听', () => {
    const hand: Tile[] = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(TONG, 5),
      tile(TONG, 5),
      tile(TIAO, 3),
      tile(TIAO, 4),
    ]
    const melds = [peng(TONG, 7)]
    const result = countOpportunities(hand, [], { melds })
    expect(result.total).toBe(8)
    expect(result.structuralWaits.map(wait => wait.tile)).toEqual([tile(TIAO, 2), tile(TIAO, 5)])
    expect(classifyWaitShape(hand, result.structuralWaits, { melds })).toBe('twoSided')
  })

  it('暗手张数与副露数不匹配时不计算伪机会数', () => {
    const invalid = Array.from({ length: 12 }, (_, index) => tile(WAN, index % 9 + 1))
    expect(countOpportunities(invalid)).toEqual({ total: 0, waits: [], structuralWaits: [] })
    expect(countOpportunities(invalid.slice(0, 9), [], { melds: [peng(TONG, 7)] }))
      .toEqual({ total: 0, waits: [], structuralWaits: [] })
  })

  it('公开信息超过四张时剩余数钳制为 0', () => {
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
    const result = countOpportunities(hand, Array.from({ length: 5 }, () => tile(TIAO, 5)))
    expect(result.total).toBe(0)
    expect(result.structuralWaits).toEqual([{ tile: tile(TIAO, 5), remaining: 0 }])
  })
})

describe('强组合（27/37/38）', () => {
  it('27/37/38 是强组合，其他组合不是', () => {
    expect(isStrongCombo(2, 7)).toBe(true)
    expect(isStrongCombo(7, 2)).toBe(true)
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

  it('同值牌有两张时只打掉一张，不误判组合消失', () => {
    expect(brokenStrongCombos([tile(WAN, 2), tile(WAN, 2), tile(WAN, 7)], tile(WAN, 2))).toEqual([])
  })

  it('不同花色不能组成强组合，手中不存在的弃牌也不产生诊断', () => {
    expect(brokenStrongCombos([tile(WAN, 2), tile(TIAO, 7)], tile(WAN, 2))).toEqual([])
    expect(brokenStrongCombos([tile(WAN, 2), tile(WAN, 7)], tile(WAN, 3))).toEqual([])
  })
})

describe('听牌形态分类', () => {
  it('根据手牌结构区分单吊、间张和边张', () => {
    const fixed = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
    ]
    const single = [...fixed, tile(TONG, 1), tile(TONG, 2), tile(TONG, 3), tile(TIAO, 5)]
    const kanchan = [...fixed, tile(TONG, 5), tile(TONG, 5), tile(TIAO, 3), tile(TIAO, 5)]
    const edge = [...fixed, tile(TONG, 5), tile(TONG, 5), tile(TIAO, 1), tile(TIAO, 2)]
    const classify = (hand: Tile[]) => {
      const result = countOpportunities(hand)
      return classifyWaitShape(hand, result.structuralWaits)
    }
    expect(classify(single)).toBe('single')
    expect(classify(kanchan)).toBe('kanchan')
    expect(classify(edge)).toBe('other')
  })

  it('同花色相差三的两个结构叫口识别为两头听', () => {
    const hand = [
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
    const result = countOpportunities(hand)
    expect(classifyWaitShape(hand, result.structuralWaits)).toBe('twoSided')
  })

  it('23456 复合结构识别为三面听', () => {
    const hand = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
      tile(TONG, 5),
      tile(TONG, 5),
      tile(TIAO, 2),
      tile(TIAO, 3),
      tile(TIAO, 4),
      tile(TIAO, 5),
      tile(TIAO, 6),
    ]
    const result = countOpportunities(hand)
    expect(result.structuralWaits.map(wait => wait.tile.value)).toEqual([1, 4, 7])
    expect(classifyWaitShape(hand, result.structuralWaits)).toBe('threeSided')
  })

  it('跨花色双碰不是两头听，缺少手牌时不猜单叫口形态', () => {
    const hand = [
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
      tile(TIAO, 7),
      tile(TIAO, 7),
    ]
    const result = countOpportunities(hand)
    expect(result.structuralWaits).toHaveLength(2)
    expect(classifyWaitShape(hand, result.structuralWaits)).toBe('other')
    expect(classifyWaitShape([{ tile: tile(WAN, 5), remaining: 3 }])).toBe('other')
  })

  it('一端已成死叫时仍按全部结构叫口识别两头听', () => {
    const hand = [
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
    const result = countOpportunities(hand, Array.from({ length: 4 }, () => tile(TIAO, 2)))
    expect(result.waits).toHaveLength(1)
    expect(classifyWaitShape(hand, result.structuralWaits)).toBe('twoSided')
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

  it('跟打优先级为上家、对家、下家', () => {
    const score = (familiarBy: Parameters<typeof assessDiscardSafety>[0]['familiarBy']) =>
      assessDiscardSafety({ value: 5, isLateGame: false, familiarBy }).score
    expect(score({ upper: true })).toBeGreaterThan(score({ opposite: true }))
    expect(score({ opposite: true })).toBeGreaterThan(score({ lower: true }))
  })

  it('同花色鸣牌降低安全分，定缺对手只提供有限修正', () => {
    const base = assessDiscardSafety({ value: 4, isLateGame: false }).score
    const pressured = assessDiscardSafety({
      value: 4,
      isLateGame: false,
      opponentMeldCount: 3,
      sameSuitOpponentMeldCount: 2,
    }).score
    const relieved = assessDiscardSafety({
      value: 4,
      isLateGame: false,
      opponentMeldCount: 3,
      sameSuitOpponentMeldCount: 2,
      dingqueOpponentCount: 1,
    }).score
    expect(pressured).toBeLessThan(base)
    expect(relieved).toBeGreaterThan(pressured)
    expect(relieved).toBeLessThanOrEqual(1)
  })
})

describe('杠牌不破坏牌型结构', () => {
  it('一副杠补牌前 10 张、补牌后 11 张均为合法阶段', () => {
    expect(gangBreaksStructure(10, 1, 'beforeReplacement')).toBe(false)
    expect(gangBreaksStructure(11, 1, 'afterReplacement')).toBe(false)
  })

  it('混淆补牌阶段或传入非法副露数会被拒绝', () => {
    expect(gangBreaksStructure(11, 1, 'beforeReplacement')).toBe(true)
    expect(gangBreaksStructure(10, 1, 'afterReplacement')).toBe(true)
    expect(gangBreaksStructure(13, 0)).toBe(true)
  })

  it('杠后保留两头听且机会数未明显下降时结构可保留', () => {
    const hand = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(TONG, 5),
      tile(TONG, 5),
      tile(TIAO, 3),
      tile(TIAO, 4),
    ]
    const assessment = assessGangStructure(hand, [peng(TONG, 7)], {
      referenceOpportunity: 8,
      referenceStructuralWaits: 2,
    })
    expect(assessment.preservesStructure).toBe(true)
    expect(assessment.opportunity.total).toBe(8)
  })

  it('张数合法但杠后丢失下叫，仍判定破坏结构', () => {
    const hand = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(TONG, 5),
      tile(TONG, 5),
      tile(TIAO, 3),
      tile(TIAO, 7),
    ]
    const assessment = assessGangStructure(hand, [peng(TONG, 7)], {
      referenceOpportunity: 8,
      referenceStructuralWaits: 2,
    })
    expect(assessment.countValid).toBe(true)
    expect(assessment.breaksReadyState).toBe(true)
    expect(assessment.preservesStructure).toBe(false)
  })

  it('杠后仍下叫但从两头听降为单吊，识别为明显机会数损失', () => {
    const hand = [
      tile(WAN, 1),
      tile(WAN, 2),
      tile(WAN, 3),
      tile(WAN, 4),
      tile(WAN, 5),
      tile(WAN, 6),
      tile(WAN, 7),
      tile(WAN, 8),
      tile(WAN, 9),
      tile(TIAO, 5),
    ]
    const assessment = assessGangStructure(hand, [peng(TONG, 7)], {
      referenceOpportunity: 8,
      referenceStructuralWaits: 2,
    })
    expect(assessment.opportunity.total).toBe(3)
    expect(assessment.materiallyReducesOpportunity).toBe(true)
    expect(assessment.preservesStructure).toBe(false)
  })
})
