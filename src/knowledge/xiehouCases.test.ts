// 邂逅五合集决策卡 · 注入校验
import { describe, expect, it } from 'vitest'
import { XIAOSHI_CASES } from './xiaoshiCases'
import { XIEHOU_CASES, getXiehouCase, getXiehouCasesByTheme } from './xiehouCases'
import { ALL_XIAOSHI_CASES } from './xiaoshiKnowledge'
import type { DecisionTheme } from './xiaoshiTypes'

const VALID_THEMES: DecisionTheme[] = [
  '期望与进攻',
  '防守与逃跑',
  '形势与信息',
  '对子搭子与牌效率',
  '找叫与选叫',
  '单钓七对与特殊牌型',
  '整局实战与复盘',
  '心态与理念',
]

describe('邂逅决策卡注入', () => {
  it('共 621 条且 id 全局唯一', () => {
    expect(XIEHOU_CASES.length).toBe(621)
    const ids = XIEHOU_CASES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('id 前缀 xh_ 且与破晓哥 216 卡无冲突', () => {
    const xiaoIds = new Set(XIAOSHI_CASES.map(c => c.id))
    for (const c of XIEHOU_CASES) {
      expect(c.id.startsWith('xh_'), `非预期前缀: ${c.id}`).toBe(true)
      expect(xiaoIds.has(c.id), `与破晓哥卡 id 冲突: ${c.id}`).toBe(false)
    }
  })

  it('theme 全部落在 8 个 DecisionTheme 枚举内', () => {
    for (const c of XIEHOU_CASES) {
      expect(VALID_THEMES, `非法 theme: ${c.theme}`).toContain(c.theme)
    }
  })

  it('每条都有理由原话、source 溯源、口播置信度区间', () => {
    for (const c of XIEHOU_CASES) {
      expect(c.reasonQuotes.length).toBeGreaterThan(0)
      expect(c.confidence).toBeGreaterThanOrEqual(0.7)
      expect(c.confidence).toBeLessThanOrEqual(0.85)
      expect(c.source).not.toBeNull()
      expect(c.source!.videoId.length).toBeGreaterThan(0)
      expect(c.source!.title.length).toBeGreaterThan(0)
      expect(typeof c.source!.t).toBe('number')
      // 批量萃取无结构化局面/行动，留空（宁缺毋滥）
      expect(c.situation.summary).toBe('')
      expect(c.action.type).toBe('observation')
    }
  })

  it('合并池 = 破晓哥 216 + 邂逅 621，无重叠丢失', () => {
    expect(ALL_XIAOSHI_CASES.length).toBe(XIAOSHI_CASES.length + XIEHOU_CASES.length)
    expect(ALL_XIAOSHI_CASES.length).toBeGreaterThanOrEqual(837)
  })

  it('getXiehouCase / getXiehouCasesByTheme 命中', () => {
    const first = XIEHOU_CASES[0]
    expect(getXiehouCase(first.id)).toBeDefined()
    expect(getXiehouCase('xh_nonexist')).toBeUndefined()
    const byTheme = getXiehouCasesByTheme(first.theme)
    expect(byTheme.length).toBeGreaterThan(0)
    expect(byTheme.every(c => c.theme === first.theme)).toBe(true)
  })
})
