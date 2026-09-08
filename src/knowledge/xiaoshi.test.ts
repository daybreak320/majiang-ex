// 潇老师实战决策库 · 骨架单测
import { describe, expect, it } from 'vitest'
import { SOURCE_EPISODES, XIAOSHI_CASES, getXiaoshiCase } from './xiaoshiCases'
import { XIAOSHI_RULES, validateRuleEvidence } from './xiaoshiRules'
import { isTileLabel, parseTileLabel } from './xiaoshiTypes'

describe('xiaoshi cases', () => {
  it('决策卡库非空且 id 唯一', () => {
    const ids = XIAOSHI_CASES.map(c => c.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每条卡都有理由原话与置信度区间', () => {
    for (const c of XIAOSHI_CASES) {
      expect(c.reasonQuotes.length).toBeGreaterThan(0)
      expect(c.confidence).toBeGreaterThan(0)
      expect(c.confidence).toBeLessThanOrEqual(1)
      expect(c.situation.summary.length).toBeGreaterThan(0)
    }
  })

  it('getXiaoshiCase 按 id 命中', () => {
    const first = XIAOSHI_CASES[0]
    expect(getXiaoshiCase(first.id)).toBeDefined()
    expect(getXiaoshiCase('cas_nonexist')).toBeUndefined()
  })

  it('知识库规模回归（同步器产出下限，防止漏卡）', () => {
    // 基线：12 期 / 51 卡 / 36 规则（2026-09-07 批量萃取后）
    expect(Object.keys(SOURCE_EPISODES).length).toBeGreaterThanOrEqual(12)
    expect(XIAOSHI_CASES.length).toBeGreaterThanOrEqual(51)
    expect(XIAOSHI_RULES.length).toBeGreaterThanOrEqual(36)
    // 每张卡都要有牌河/局面摘要与至少一个行动
    for (const c of XIAOSHI_CASES) {
      expect(c.action.detail.length).toBeGreaterThan(0)
    }
  })

  it('第 002 期（该怂就怂）已入库：点炮胡行动 + 防守主题', () => {
    expect(Object.keys(SOURCE_EPISODES)).toContain('cas-002')
    const d2 = getXiaoshiCase('cas_002_d2')
    expect(d2).toBeDefined()
    expect(d2!.action.type).toBe('hu')
    expect(d2!.theme).toBe('防守与逃跑')
    const escape = XIAOSHI_RULES.find(r => r.id === 'R-THREAT-ESCAPE-v0')
    expect(escape).toBeDefined()
    expect(escape!.rationale).toContain('该怂')
    expect(escape!.evidence).toContain('cas_002_d2')
    // 每期至少一张卡；期数键(cas-002)与卡前缀(cas_002)一一对应
    const prefixes = new Set(XIAOSHI_CASES.map(c => c.id.split('_d')[0]))
    for (const key of Object.keys(SOURCE_EPISODES)) {
      expect(prefixes.has(key.replace(/-/g, '_')), `期 ${key} 缺少决策卡`).toBe(true)
    }
  })
})

describe('xiaoshi rules', () => {
  it('规则库非空且 id 唯一', () => {
    const ids = XIAOSHI_RULES.map(r => r.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('规则引用证据与决策卡库完整闭环', () => {
    const caseIds = new Set(XIAOSHI_CASES.map(c => c.id))
    expect(validateRuleEvidence(caseIds)).toEqual([])
  })

  it('单期证据规则置信度 ≤ 0.85', () => {
    for (const r of XIAOSHI_RULES) {
      if (r.evidence.length === 1) {
        expect(r.confidence).toBeLessThanOrEqual(0.85)
      }
    }
  })
})

describe('tile label helper', () => {
  it('解析合法牌面标签', () => {
    expect(parseTileLabel('3筒')).toEqual({ type: 'tong', value: 3 })
    expect(parseTileLabel('6条')).toEqual({ type: 'tiao', value: 6 })
    expect(parseTileLabel('9万')).toEqual({ type: 'wan', value: 9 })
  })

  it('拒绝非法标签', () => {
    expect(parseTileLabel('0万')).toBeNull()
    expect(parseTileLabel('10条')).toBeNull()
    expect(parseTileLabel('中')).toBeNull()
    expect(isTileLabel('1万')).toBe(true)
    expect(isTileLabel('红中')).toBe(false)
  })
})
