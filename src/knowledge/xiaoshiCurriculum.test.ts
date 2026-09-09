/**
 * 破晓哥课程库单测：数据完整性 + 查询函数行为
 */
import { describe, it, expect } from 'vitest'
import {
  xiaoshiClusters,
  xiaoshiPath,
  xiaoshiLessons,
  xiaoshiLessonCount,
  findLessonsByTitle,
  lessonsOfLayer,
} from './xiaoshiCurriculum'

describe('课程库数据完整性', () => {
  it('8 大教学簇 + 生活互动簇齐全，条数与主题地图 v1 对账', () => {
    const byCode = new Map(xiaoshiClusters.map(c => [c.code, c]))
    // v1 抓取基线（若主题地图升级，此处同步更新）
    expect(byCode.get('E')!.titles.length).toBe(76)
    expect(byCode.get('M')!.titles.length).toBe(43)
    expect(byCode.get('D')!.titles.length).toBe(27)
    expect(byCode.get('I')!.titles.length).toBe(34)
    expect(byCode.get('P')!.titles.length).toBe(19)
    expect(byCode.get('T')!.titles.length).toBe(32)
    expect(byCode.get('S')!.titles.length).toBe(17)
    expect(byCode.get('G')!.titles.length).toBe(12)
    expect(xiaoshiLessonCount).toBe(260)
  })

  it('每簇标题无重复、无空串', () => {
    for (const c of xiaoshiClusters) {
      expect(new Set(c.titles).size).toBe(c.titles.length)
      for (const t of c.titles) expect(t.trim().length).toBeGreaterThan(0)
    }
  })

  it('精读清单必须是本簇标题的子集（模糊匹配口径）', () => {
    for (const c of xiaoshiClusters) {
      for (const mr of c.mustRead) {
        const hit = c.titles.some(t => t.includes(mr) || mr.includes(t))
        expect(hit, `${c.code} 精读「${mr}」不在簇内`).toBe(true)
      }
    }
  })

  it('学习路径 4 层覆盖全部教学簇，X 不入课表', () => {
    expect(xiaoshiPath).toHaveLength(4)
    const covered = new Set(xiaoshiPath.flatMap(l => l.clusters))
    for (const code of ['E', 'D', 'I', 'P', 'T', 'S', 'G', 'M'] as const) {
      expect(covered.has(code), `教学簇 ${code} 必须出现在路径中`).toBe(true)
    }
    expect(covered.has('X')).toBe(false)
    expect(xiaoshiLessons.every(l => l.cluster !== 'X' ? l.layerId !== null : true)).toBe(true)
  })

  it('M0 已萃取的期数在库中且标记精读', () => {
    const hit = findLessonsByTitle('暂时不要叫')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit[0].cluster).toBe('T')
    expect(hit[0].mustRead).toBe(true)
    expect(hit[0].layerId).toBe('L2')
  })
})

describe('课程查询函数', () => {
  it('findLessonsByTitle：命中返回课程，空查询返回空数组', () => {
    expect(findLessonsByTitle('对子不能无脑留')[0].cluster).toBe('P')
    expect(findLessonsByTitle('  ')).toEqual([])
    expect(findLessonsByTitle('不存在的标题XYZ')).toEqual([])
  })

  it('lessonsOfLayer：L1 全部为 M 簇；X 类不出现在任何层', () => {
    const l1 = lessonsOfLayer('L1')
    expect(l1.length).toBeGreaterThan(0)
    expect(new Set(l1.map(l => l.cluster))).toEqual(new Set(['M']))
    const all = xiaoshiPath.flatMap(l => lessonsOfLayer(l.id))
    expect(all.every(l => l.cluster !== 'X')).toBe(true)
  })
})
