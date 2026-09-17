// 赛中导师 · 用户异议 / 讨论视角持久化层
// 把破晓在局中反馈的「不同意见」存进 localStorage，跨局跨天都记得；
// 并以轻量 UserAngle 形式注入建议引擎，让同类局面多出「你的思考角度」。
// 纯前端、无 LLM：导师回应是诚实的模板化记录，不假装深度推理。
import type { DecisionTheme, UserAngle } from './xiaoshiTypes'

/** 讨论状态：open=待消化；accepted=已纳入导师思考；kept=保留异议（导师不强行认同） */
export type PerspectiveStatus = 'open' | 'accepted' | 'kept'

/** 一条被导师记住的用户视角（存储结构） */
export interface UserPerspective {
  id: string
  ruleId: string | null
  theme: DecisionTheme | null
  text: string
  createdAt: number
  status: PerspectiveStatus
  /** 导师的诚实回应（模板化，非 LLM 推理），记录讨论轨迹 */
  mentorNote?: string
}

const STORAGE_KEY = 'xiaoshi:user-perspectives'
const MAX_ANGLES_PER_CARD = 2
const NOTE_SNIPPET_LEN = 24

function safeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      return window.localStorage
  }
  catch {
    // 隐私模式 / 沙箱 / SSR 下访问 localStorage 可能抛错——降级为内存态
  }
  return null
}

function isValidPerspective(x: unknown): x is UserPerspective {
  if (x === null || typeof x !== 'object')
    return false
  const p = x as Record<string, unknown>
  return typeof p.id === 'string' && typeof p.text === 'string'
}

/** 读取全部用户视角（解析失败/空/非数组均降级为空数组） */
export function loadPerspectives(): UserPerspective[] {
  const s = safeStorage()
  if (s === null)
    return []
  const raw = s.getItem(STORAGE_KEY)
  if (!raw)
    return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr))
      return []
    return arr.filter(isValidPerspective)
  }
  catch {
    return []
  }
}

/** 覆盖写入全部视角（配额/隐私模式静默降级） */
export function savePerspectives(list: UserPerspective[]): void {
  const s = safeStorage()
  if (s === null)
    return
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(list))
  }
  catch {
    // 忽略写入失败，不阻断对局
  }
}

function makeId(): string {
  return `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function snippetOf(text: string): string {
  const t = text.trim()
  return t.length > NOTE_SNIPPET_LEN ? `${t.slice(0, NOTE_SNIPPET_LEN)}…` : t
}

/** 为一条用户异议生成诚实的导师回应（模板化，不假装 LLM 推理） */
export function makeMentorNote(angle: { ruleId: string | null, theme: DecisionTheme | null }, snippet: string): string {
  const scope = angle.ruleId
    ? '这条规则'
    : angle.theme
      ? `「${angle.theme}」`
      : '这类局面'
  return `收到，这个角度我记下了：${snippet} 下次遇到${scope}，我会把你的判断和破晓哥原话一并摆出来，不替你下唯一结论——你拍板。`
}

export interface NewPerspective {
  ruleId: string | null
  theme: DecisionTheme | null
  text: string
  /** 可选自定义导师回应；省略则自动生成 */
  mentorNote?: string
}

/** 新增一条用户视角并落盘，返回完整对象 */
export function addPerspective(input: NewPerspective): UserPerspective {
  const text = input.text.trim()
  const item: UserPerspective = {
    id: makeId(),
    ruleId: input.ruleId,
    theme: input.theme,
    text,
    createdAt: Date.now(),
    status: 'open',
    mentorNote: input.mentorNote ?? makeMentorNote(input, snippetOf(text)),
  }
  const list = loadPerspectives()
  list.push(item)
  savePerspectives(list)
  return item
}

/** 切换某条视角的消化状态（已纳入/保留异议），返回更新后的对象或 null */
export function setPerspectiveStatus(id: string, status: PerspectiveStatus): UserPerspective | null {
  const list = loadPerspectives()
  const idx = list.findIndex(p => p.id === id)
  if (idx < 0)
    return null
  list[idx] = { ...list[idx], status }
  savePerspectives(list)
  return list[idx]
}

/** 把存储视角转换为注入建议引擎的轻量角度 */
export function toUserAngles(list: UserPerspective[]): UserAngle[] {
  return list.map(p => ({ id: p.id, ruleId: p.ruleId, theme: p.theme, text: p.text }))
}

export { MAX_ANGLES_PER_CARD }
