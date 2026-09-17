import type { DecisionTheme, MentorStance, UserAngle } from './xiaoshiTypes'
// 赛中导师 · 用户异议 / 讨论视角持久化层
// 把破晓在局中反馈的「不同意见」存进 localStorage，跨局跨天都记得；
// 并以轻量 UserAngle 形式注入建议引擎，让同类局面多出「你的思考角度」。
// 纯前端、无 LLM：导师回应是诚实的模板化记录，不假装深度推理。
import { XIAOSHI_RULES } from './xiaoshiRules'

/** 讨论状态：open=待消化；accepted=已纳入导师思考；kept=保留异议（导师不强行认同） */
export type PerspectiveStatus = 'open' | 'accepted' | 'kept'

/** 导师立场的依据——抬杠也要有据可依，不能空口反对 */
export interface MentorBasis {
  ruleName?: string
  confidence?: number
  boundary?: string
  rationale?: string
  evidenceCount?: number
}

/** 导师对一条用户异议的回应（含立场 + 依据） */
export interface MentorResponse {
  stance: MentorStance
  /** 完整回应（讨论记录用） */
  text: string
  /** 一句话立场（建议卡内联用） */
  line: string
  basis?: MentorBasis
}

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
  /** 导师立场：agree/partial/hold——导师也要有自己的不同意见 */
  stance?: MentorStance
  /** 一句话立场（含依据摘要） */
  mentorLine?: string
  /** 立场依据（规则名/置信度/边界/原话/证据数） */
  mentorBasis?: MentorBasis
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

/**
 * 生成导师对用户异议的「有立场」回应——导师不当应声虫。
 * 立场由规则的硬证据决定（确定性、可解释，不假装推理）：
 * - confidence ≥ 0.85（跨期复现、证据硬）→ hold：保留判断，明确提出不同意见
 * - 0.75 ≤ confidence < 0.85 → partial：看边界，落在边界外才采纳
 * - confidence < 0.75 → agree：导师认输，采纳用户角度
 * - 未绑定具体规则 → partial：拿不出对等依据，只记为通用角度
 */
export function makeMentorResponse(
  angle: { ruleId: string | null, theme: DecisionTheme | null },
  snippet: string,
): MentorResponse {
  const rule = angle.ruleId === null ? undefined : XIAOSHI_RULES.find(r => r.id === angle.ruleId)
  if (!rule) {
    const scope = angle.theme ? `「${angle.theme}」` : '这类局面'
    return {
      stance: 'partial',
      text: `记下了：${snippet}。不过这条没绑定到具体规则，我拿不出对等的依据跟你辩，只能在${scope}里把你的角度一并摆出来——等有更多实战证据再来分对错。`,
      line: '没绑规则，我记为通用角度，但拿不出对等依据',
    }
  }
  const pct = `${(rule.confidence * 100).toFixed(0)}%`
  const ev = rule.evidence.length
  const basis: MentorBasis = {
    ruleName: rule.name,
    confidence: rule.confidence,
    ...(rule.boundary ? { boundary: rule.boundary } : {}),
    rationale: rule.rationale,
    evidenceCount: ev,
  }
  if (rule.confidence >= 0.85) {
    return {
      stance: 'hold',
      text: `记下了：${snippet}。但这条我先保留我的判断，跟你唱个反调——破晓哥这条有 ${ev} 个实例支撑、置信度 ${pct}，原话是「${rule.rationale}」。你的角度我会一并摆出来，可只要还落在「${rule.trigger}」这类局面，我仍会先给原判断：你拍板，但我不当应声虫。`,
      line: `我保留意见：这条置信度 ${pct}、${ev} 个实例支撑`,
      basis,
    }
  }
  if (rule.confidence >= 0.75) {
    return {
      stance: 'partial',
      text: `记下了：${snippet}。分情况说——这条的边界是「${rule.boundary ?? '未标注'}」。如果你说的是边界之外的情形，你的角度成立，我采纳；若仍落在「${rule.trigger}」里，我还是按破晓哥原话「${rule.rationale}」给判断。你下次留意自己站在哪一边。`,
      line: `看边界：${rule.boundary ?? '未标注'}`,
      basis,
    }
  }
  return {
    stance: 'agree',
    text: `记下了：${snippet}。这条你说服我了——它置信度只有 ${pct}（${ev} 个实例），本来就不硬。下次同类局面我优先按你的思路提示，只在「${rule.trigger}」时留一句破晓哥原话「${rule.rationale}」作对照。`,
    line: `这条我认你的（置信度仅 ${pct}），采纳你的角度`,
    basis,
  }
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
  // 自定义回应（测试/迁移用）走兜底；否则按规则硬证据生成有立场的回应
  const resp = input.mentorNote
    ? { stance: 'partial' as MentorStance, text: input.mentorNote, line: input.mentorNote }
    : makeMentorResponse(input, snippetOf(text))
  const item: UserPerspective = {
    id: makeId(),
    ruleId: input.ruleId,
    theme: input.theme,
    text,
    createdAt: Date.now(),
    status: 'open',
    mentorNote: resp.text,
    stance: resp.stance,
    mentorLine: resp.line,
    ...(resp.basis ? { mentorBasis: resp.basis } : {}),
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
  return list.map(p => ({
    id: p.id,
    ruleId: p.ruleId,
    theme: p.theme,
    text: p.text,
    ...(p.stance ? { stance: p.stance } : {}),
    ...(p.mentorLine ? { mentorLine: p.mentorLine } : {}),
  }))
}

export { MAX_ANGLES_PER_CARD }
