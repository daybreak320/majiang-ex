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
  /** 依据是按主题匹配到的（非用户显式绑定某条规则） */
  viaTheme?: boolean
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

/** 跨面板同步事件：任一入口写入后广播，导师面板据此重读（避免多面板状态不一致） */
const CHANGE_EVENT = 'xiaoshi:perspectives-changed'

function emitChange(): void {
  try {
    if (typeof window !== 'undefined')
      window.dispatchEvent(new Event(CHANGE_EVENT))
  }
  catch {
    // 无 window / 派发失败时静默，不阻断对局
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
  // 绑定顺序：指定规则 → 该主题下置信度最高的一条 → 无
  const rule = angle.ruleId !== null
    ? XIAOSHI_RULES.find(r => r.id === angle.ruleId)
    : angle.theme !== null
      ? [...XIAOSHI_RULES]
          .filter(r => r.theme === angle.theme)
          .sort((a, b) => b.confidence - a.confidence)[0]
      : undefined
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
    ...(angle.ruleId === null ? { viaTheme: true } : {}),
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
  emitChange()
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
  emitChange()
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

/* ───────────────────────── 导师段位 · 阶段性进阶讨论 ─────────────────────────
 * 不同意见不是流水账：攒到一定量，导师做一次「阶段对谈」并晋升段位，
 * 让"提异议 → 被记住 → 有回响 → 更敢提"形成循环。
 * 分值口径（确定性、可解释）：待消化 1 / 保留异议 2 / 已纳入 3——被采纳的思考最值钱。
 */

export interface MentorProgress {
  /** 段位序号，从 1 起 */
  level: number
  /** 段位名（跟破晓哥学牌的口气，不做游戏化称号堆砌） */
  title: string
  /** 段位分值 */
  score: number
  /** 下一级门槛；已到顶为 null */
  nextThreshold: number | null
  total: number
  accepted: number
  kept: number
  open: number
  stanceCounts: { agree: number, partial: number, hold: number }
  /** 讨论最集中的主题（无则 null） */
  topTheme: DecisionTheme | null
}

/** 段位门槛表：分数达标即晋升 */
export const MENTOR_LEVELS = [
  { threshold: 0, title: '初听牌路' },
  { threshold: 6, title: '敢提异议' },
  { threshold: 15, title: '交锋成习' },
  { threshold: 30, title: '牌桌诤友' },
  { threshold: 50, title: '棋逢对手' },
] as const

export function computeMentorProgress(list: UserPerspective[]): MentorProgress {
  const weight: Record<PerspectiveStatus, number> = { open: 1, kept: 2, accepted: 3 }
  const score = list.reduce((sum, p) => sum + weight[p.status], 0)
  const stanceCounts = { agree: 0, partial: 0, hold: 0 }
  const themeCount = new Map<DecisionTheme, number>()
  for (const p of list) {
    if (p.stance)
      stanceCounts[p.stance]++
    if (p.theme)
      themeCount.set(p.theme, (themeCount.get(p.theme) ?? 0) + 1)
  }
  const topTheme = [...themeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  let level = 1
  for (let i = 0; i < MENTOR_LEVELS.length; i++) {
    if (score >= MENTOR_LEVELS[i].threshold)
      level = i + 1
  }
  const next = MENTOR_LEVELS[level]
  return {
    level,
    title: MENTOR_LEVELS[level - 1].title,
    score,
    nextThreshold: next ? next.threshold : null,
    total: list.length,
    accepted: list.filter(p => p.status === 'accepted').length,
    kept: list.filter(p => p.status === 'kept').length,
    open: list.filter(p => p.status === 'open').length,
    stanceCounts,
    topTheme,
  }
}

/** 阶段对谈：晋升时的导师小结（模板化生成，确定性、有数据出处） */
export function buildStageTalk(progress: MentorProgress): string {
  if (progress.total === 0)
    return '咱们还没交过手。遇到不认同的建议别憋着——你提一次，我们就多一次把道理摆到桌面上的机会。'
  const stanceLine = `这阶段你提了 ${progress.total} 条不同意见（我认同 ${progress.stanceCounts.agree} · 分情况 ${progress.stanceCounts.partial} · 我保留 ${progress.stanceCounts.hold}），其中 ${progress.accepted} 条已纳入我的思考${progress.topTheme ? `，聊得最多的是「${progress.topTheme}」` : ''}。`
  const holds = progress.stanceCounts.hold
  const agrees = progress.stanceCounts.agree
  const partials = progress.stanceCounts.partial
  let advice: string
  if (holds > agrees && holds >= partials) {
    advice = '你跟我顶牛顶得最凶的地方，恰恰是最值得拆的地方——挑一条你最不服的，我们逐张牌对：它有几个实例支撑、边界在哪、你的角度在哪种局面下能反过来赢它。'
  }
  else if (partials >= agrees) {
    advice = '「分情况」的判断最见功力。下一阶段别停在"我觉得要看情况"——把"什么情况下不成立"也写全，那才是能落进实战的判断。'
  }
  else {
    advice = '多数时候是你说服了我，说明你的牌感已经在规则前面跑。下一阶段换个练法：出牌前先自己下结论，再看我给的建议——重点盯我们结论不一致的那几手。'
  }
  return `${stanceLine}${advice}`
}

/* ───────────────────────── 段位已读标记（进阶对谈只弹新的一次） ───────────────────────── */

const SEEN_STAGE_KEY = 'xiaoshi:mentor-stage-seen'

/** 已展示过的段位序号（0 = 从未展示） */
export function loadSeenStage(): number {
  const s = safeStorage()
  if (s === null)
    return Number.MAX_SAFE_INTEGER
  const raw = s.getItem(SEEN_STAGE_KEY)
  const n = raw === null ? 0 : Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function markStageSeen(level: number): void {
  const s = safeStorage()
  if (s === null)
    return
  try {
    s.setItem(SEEN_STAGE_KEY, String(level))
  }
  catch {
    // 写不进去就静默：下次再弹一次，无伤大雅
  }
}

export { CHANGE_EVENT, MAX_ANGLES_PER_CARD }
