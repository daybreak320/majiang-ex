import type { Tile, TileType } from '../types'
import type { Meld, MeldKind, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { calculateScore, getQiDuiLevel, identifyFanPatterns, isWinningHand } from './scoring'

function tiles(specification: string): Tile[] {
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map(value => ({ type, value: Number(value) }))
  })
}

function meld(kind: MeldKind, specification: string): Meld {
  return {
    kind,
    fromPlayer: kind === 'anGang' ? null : 1,
    tiles: tiles(specification).map((tile, index): TileInstance => ({ ...tile, id: `${kind}-${index}` })),
  }
}

function patternIds(hand: Tile[], melds: Meld[] = []): string[] {
  return identifyFanPatterns(hand, { melds }).map(pattern => pattern.id)
}

describe('胡牌基础判定', () => {
  it('识别标准胡并拒绝非胡', () => {
    expect(isWinningHand(tiles('123万 456万 123条 789筒 55条'))).toBe(true)
    expect(isWinningHand(tiles('123万 456万 124条 789筒 55条'))).toBe(false)
  })

  it('按已有副露数判定闭合手牌组数', () => {
    const hand = tiles('123万 456条 789筒 55条')
    expect(isWinningHand(hand, { melds: [meld('peng', '222万')] })).toBe(true)
  })

  it('持有定缺花色时禁止胡', () => {
    const hand = tiles('123万 456万 123条 789筒 55条')
    expect(isWinningHand(hand, { dingque: '万' })).toBe(false)
    expect(isWinningHand(hand, { dingque: '筒' })).toBe(false)
  })
})

describe('七对与番型', () => {
  it('识别普通七对且不重复叠加升级牌型', () => {
    const hand = tiles('11万 22万 33条 44条 55筒 66筒 77筒')
    expect(getQiDuiLevel(hand)).toBe(1)
    expect(patternIds(hand)).toEqual(['qiDui'])
    expect(calculateScore(hand)?.baseFan).toBe(2)
  })

  it('四张同牌按两对识别龙七对', () => {
    const hand = tiles('1111万 22万 33条 44条 55筒 66筒')
    expect(getQiDuiLevel(hand)).toBe(2)
    expect(patternIds(hand)).toEqual(['longQiDui'])
    expect(calculateScore(hand)?.baseFan).toBe(3)
  })

  it('识别双龙七对', () => {
    const hand = tiles('1111万 2222条 33条 44筒 55筒')
    expect(getQiDuiLevel(hand)).toBe(3)
    expect(patternIds(hand)).toEqual(['shuangLongQiDui'])
    expect(calculateScore(hand)?.baseFan).toBe(4)
  })

  it('清七对覆盖清一色和其他七对升级，不异常叠加', () => {
    const hand = tiles('1111万 22万 33万 44万 55万 66万')
    expect(patternIds(hand)).toEqual(['qingQiDui'])
    expect(calculateScore(hand)?.baseFan).toBe(4)
  })

  it('识别平胡 0 番', () => {
    const hand = tiles('123万 456万 123条 789筒 55条')
    expect(patternIds(hand)).toEqual(['pingHu'])
    expect(calculateScore(hand)).toMatchObject({ baseFan: 0, scoringFan: 0, points: 1 })
  })

  it('识别碰碰胡和清一色', () => {
    const pengPengHu = tiles('111万 222万 333条 444筒 55条')
    const qingYiSe = tiles('123万 456万 789万 111万 22万')
    expect(patternIds(pengPengHu)).toContain('pengPengHu')
    expect(calculateScore(pengPengHu)?.baseFan).toBe(1)
    expect(patternIds(qingYiSe)).toContain('qingYiSe')
    expect(calculateScore(qingYiSe)?.baseFan).toBe(2)
  })

  it('四副露单吊将识别金钩钓', () => {
    const exposed = [
      meld('peng', '111万'),
      meld('peng', '222条'),
      meld('mingGang', '3333筒'),
      meld('anGang', '4444万'),
    ]
    const hand = tiles('55条')
    expect(patternIds(hand, exposed)).toContain('jinGouDiao')
    expect(calculateScore(hand, { melds: exposed })?.baseFan).toBe(3)
  })

  it('接受后续特殊番输入但总番封顶 5', () => {
    const hand = tiles('123万 456万 123条 789筒 55条')
    expect(calculateScore(hand, { specialFan: 9 })).toMatchObject({
      baseFan: 0,
      specialFan: 9,
      scoringFan: 5,
      points: 32,
    })
  })
})
