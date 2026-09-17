// 破晓哥镜像导师 · 用户异议持久化单测
// 不依赖 jsdom：用内存版 localStorage 模拟浏览器 window，保持 node 环境可跑。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addPerspective,
  loadPerspectives,
  makeMentorNote,
  setPerspectiveStatus,
  toUserAngles,
} from './xiaoshiDissent'

class MemStorage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  getItem(k: string) { return this.map.has(k) ? (this.map.get(k) as string) : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
  key(i: number) { return [...this.map.keys()][i] ?? null }
}

const mem = new MemStorage()
const savedWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  mem.clear()
  ;(globalThis as { window?: unknown }).window = { localStorage: mem }
})
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = savedWindow
})

describe('xiaoshiDissent：用户异议持久化', () => {
  beforeEach(() => {
    mem.clear()
  })

  it('空库返回空数组', () => {
    expect(loadPerspectives()).toEqual([])
  })

  it('addPerspective 落盘并回填 id/createdAt/status/mentorNote', () => {
    const p = addPerspective({ ruleId: 'R-X', theme: null, text: '下家打 7 筒我也觉得不能武断' })
    expect(p.id).toMatch(/^up_/)
    expect(p.status).toBe('open')
    expect(p.mentorNote).toContain('记下了')
    const all = loadPerspectives()
    expect(all).toHaveLength(1)
    expect(all[0].text).toBe('下家打 7 筒我也觉得不能武断')
  })

  it('多条按时间累加存储', () => {
    addPerspective({ ruleId: null, theme: null, text: 'a' })
    addPerspective({ ruleId: null, theme: null, text: 'b' })
    expect(loadPerspectives()).toHaveLength(2)
  })

  it('setPerspectiveStatus 切换状态', () => {
    const p = addPerspective({ ruleId: null, theme: null, text: 'x' })
    const updated = setPerspectiveStatus(p.id, 'accepted')
    expect(updated?.status).toBe('accepted')
    expect(loadPerspectives()[0].status).toBe('accepted')
    expect(setPerspectiveStatus('nope', 'kept')).toBeNull()
  })

  it('toUserAngles 转轻量角度', () => {
    const list = [addPerspective({ ruleId: 'R-X', theme: null, text: 'y' })]
    const angles = toUserAngles(list)
    expect(angles[0]).toEqual({ id: list[0].id, ruleId: 'R-X', theme: null, text: 'y' })
  })

  it('makeMentorNote 按 ruleId/theme 生成诚实回应', () => {
    expect(makeMentorNote({ ruleId: 'R-X', theme: null }, '不能武断')).toContain('这条规则')
    expect(makeMentorNote({ ruleId: null, theme: '防守与逃跑' }, '先保本')).toContain('防守与逃跑')
    expect(makeMentorNote({ ruleId: null, theme: null }, '通用')).toContain('这类局面')
  })
})
