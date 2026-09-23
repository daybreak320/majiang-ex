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

/**
 * 一条被导师记住的用户视角（存储结构）。
 * 旧 localStorage 数据只有 text/mentorNote，无 turns —— 读取时由 normalizePerspective 补默认空值，向后兼容。
 */
export interface UserPerspective {
  id: string
  ruleId: string | null
  theme: DecisionTheme | null
  text: string
  createdAt: number
  status: PerspectiveStatus
  /** 导师的诚实回应（模板化，非 LLM 推理），记录讨论轨迹（旧数据单条；新数据同时进 turns） */
  mentorNote?: string
  /** 导师立场：agree/partial/hold——导师也要有自己的不同意见 */
  stance?: MentorStance
  /** 一句话立场（含依据摘要） */
  mentorLine?: string
  /** 立场依据（规则名/置信度/边界/原话/证据数） */
  mentorBasis?: MentorBasis
  /** 多轮对谈轨迹：用户与导师交替发言，含依据与牌局 tick */
  turns?: DiscussionTurn[]
  /** 本局归属：同一局内的对谈线程挂同一个 gameId，便于局末回顾与演进跟评 */
  gameId?: string | null
  /** 导师随牌局推进主动回看（结合新信息）的次数，每线程每局上限 2 次 */
  evolveCount?: number
  /** 经验沉淀状态：pending=待沉淀 / saved=已存为经验卡候选 / dismissed=放弃 */
  distilled?: DistillStatus | null
}

/** 对谈一轮：用户或导师的发言 */
export interface DiscussionTurn {
  role: 'user' | 'mentor'
  text: string
  /** 导师发言可带依据 */
  basis?: MentorBasis
  /** 该轮发生时的牌局 tick（结合新信息用） */
  atTick?: number
}

/** 经验沉淀状态 */
export type DistillStatus = 'pending' | 'saved' | 'dismissed'

/** 实时牌面上下文（UI 在每次状态变化时计算后传入讨论引擎，可选） */
export interface LiveBoardContext {
  /** 牌局 tick（每摸/打/响应 +1），用于「结合新信息」 */
  tick: number
  /** 某牌已现张数，key = '9万' 等；来自弃牌堆 + 已亮明杠刻 */
  tileCounts?: Record<string, number>
  /** 牌墙剩余张数 */
  wallLeft?: number
  /** 最近一次被打出的牌（用于「刚刚发生」的跟评），如 '9万' */
  lastDiscard?: string
}

/** 从实战对谈沉淀出的经验卡候选（不入规则库，待人工裁决） */
export interface DistilledExperience {
  id: string
  /** 来源对谈 id */
  perspectiveId: string
  /** 本局归属 */
  gameId: string | null
  /** 经验标题（用户提炼或自动摘取） */
  title: string
  /** 对谈精华：用户角度 + 导师立场的对照 */
  summary: string
  createdAt: number
  ruleId: string | null
  theme: DecisionTheme | null
  stance: MentorStance | null
  /** 用户是否采纳为经验（采纳后进入「我的经验」，不采纳仅留痕） */
  accepted: boolean
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

/** 旧 localStorage 数据补默认空值，保证新字段（turns/gameId/evolveCount/distilled）永远存在 */
function normalizePerspective(p: UserPerspective): UserPerspective {
  return {
    ...p,
    turns: p.turns ?? [],
    gameId: p.gameId ?? null,
    evolveCount: p.evolveCount ?? 0,
    distilled: p.distilled ?? null,
  }
}

/** 取得一条视角的对谈轨迹：新数据用 turns，旧 localStorage（无 turns）回退到 text/mentorNote */
export function perspectiveTurns(p: UserPerspective): DiscussionTurn[] {
  if (p.turns && p.turns.length > 0)
    return p.turns
  return [
    { role: 'user', text: p.text },
    ...(p.mentorNote
      ? [{ role: 'mentor' as const, text: p.mentorNote, ...(p.mentorBasis ? { basis: p.mentorBasis } : {}) }]
      : []),
  ]
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
    return arr.filter(isValidPerspective).map(normalizePerspective)
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
  /** 本局归属（对谈线程挂到具体一局，便于局末回顾与演进跟评） */
  gameId?: string | null
  /** 开局 tick，记入首轮时间戳 */
  atTick?: number
}

/** 新增一条用户视角并落盘，返回完整对象（含首轮对谈 turns） */
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
    // 首轮：用户原话 + 导师首回应，组成可演进的对谈线程
    turns: [
      { role: 'user', text, ...(input.atTick !== undefined ? { atTick: input.atTick } : {}) },
      { role: 'mentor', text: resp.text, ...(resp.basis ? { basis: resp.basis } : {}), ...(input.atTick !== undefined ? { atTick: input.atTick } : {}) },
    ],
    gameId: input.gameId ?? null,
    evolveCount: 0,
    distilled: null,
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

/* ───────────────────────── 对谈线程 · 多轮演进 ─────────────────────────
 * 异议不再是「提交即收起」的一锤子买卖：每条视角是一条可多轮推进的对谈线程，
 * 导师随牌局推进结合新信息主动回看（recordEvolve，每线程每局上限 2 次），
 * 局末可由用户一键沉淀为经验卡候选（见下方 distill 存储）。
 */

/** 给某条对谈线程追加一轮（user 或 mentor），落盘并重读广播 */
export function addTurn(perspectiveId: string, turn: DiscussionTurn): UserPerspective | null {
  const list = loadPerspectives()
  const idx = list.findIndex(p => p.id === perspectiveId)
  if (idx < 0)
    return null
  const updated: UserPerspective = { ...list[idx], turns: [...(list[idx].turns ?? []), turn] }
  list[idx] = updated
  savePerspectives(list)
  emitChange()
  return updated
}

/** 记录导师一次「结合新信息」的主动回看（跟评），evolveCount+1 */
export function recordEvolve(perspectiveId: string): UserPerspective | null {
  const list = loadPerspectives()
  const idx = list.findIndex(p => p.id === perspectiveId)
  if (idx < 0)
    return null
  const updated: UserPerspective = { ...list[idx], evolveCount: (list[idx].evolveCount ?? 0) + 1 }
  list[idx] = updated
  savePerspectives(list)
  emitChange()
  return updated
}

/** 把一条对谈线程归属到具体一局（开局时调用） */
export function setGameId(perspectiveId: string, gameId: string | null): UserPerspective | null {
  const list = loadPerspectives()
  const idx = list.findIndex(p => p.id === perspectiveId)
  if (idx < 0)
    return null
  const updated: UserPerspective = { ...list[idx], gameId }
  list[idx] = updated
  savePerspectives(list)
  emitChange()
  return updated
}

/* ───────────────────────── 经验沉淀 · 局末回顾 ─────────────────────────
 * 每局收束时，用户可把本局对谈一键沉淀为「经验卡候选」——
 * 标来源=实战对谈、入 xiaoshi:distilled-experiences，不进规则库，待人工裁决。
 */

const DISTILLED_KEY = 'xiaoshi:distilled-experiences'

/** 读取全部沉淀经验（解析失败/非数组降级空数组） */
export function loadDistilled(): DistilledExperience[] {
  const s = safeStorage()
  if (s === null)
    return []
  const raw = s.getItem(DISTILLED_KEY)
  if (!raw)
    return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr))
      return []
    return arr.filter((x: unknown): x is DistilledExperience => {
      if (x === null || typeof x !== 'object')
        return false
      const d = x as Record<string, unknown>
      return typeof d.id === 'string' && typeof d.summary === 'string'
    })
  }
  catch {
    return []
  }
}

/** 覆盖写入沉淀经验（隐私模式静默降级） */
export function saveDistilled(list: DistilledExperience[]): void {
  const s = safeStorage()
  if (s === null)
    return
  try {
    s.setItem(DISTILLED_KEY, JSON.stringify(list))
  }
  catch {
    // 忽略写入失败，不阻断对局
  }
}

/** 新增一条沉淀经验，返回完整对象 */
export function addDistilled(
  input: Omit<DistilledExperience, 'id' | 'createdAt' | 'accepted'> & { accepted?: boolean },
): DistilledExperience {
  const item: DistilledExperience = {
    id: makeId(),
    createdAt: Date.now(),
    accepted: input.accepted ?? false,
    ...input,
  }
  const list = loadDistilled()
  list.push(item)
  saveDistilled(list)
  return item
}

/** 切换某条沉淀经验的采纳状态（采纳=进入「我的经验」；不采纳仅留痕） */
export function setDistilledAccepted(id: string, accepted: boolean): DistilledExperience | null {
  const list = loadDistilled()
  const idx = list.findIndex(d => d.id === id)
  if (idx < 0)
    return null
  list[idx] = { ...list[idx], accepted }
  saveDistilled(list)
  return list[idx]
}

/** 标记某条对谈线程的沉淀状态（pending=待沉淀 / saved=已存经验 / dismissed=放弃） */
export function markDistilled(perspectiveId: string, status: DistillStatus): UserPerspective | null {
  const list = loadPerspectives()
  const idx = list.findIndex(p => p.id === perspectiveId)
  if (idx < 0)
    return null
  const updated: UserPerspective = { ...list[idx], distilled: status }
  list[idx] = updated
  savePerspectives(list)
  emitChange()
  return updated
}

/* ───────────────────────── 本地讨论引擎 · 确定性接招 ─────────────────────────
 * 导师对用户后续发言的接招：不接 LLM、不假装推理，按确定性规则分类回应。
 * 三类主路径：提牌张 / 要依据 / 问边界；其余兜底承接。
 * 传入 live 牌面时，提牌张类给出现张数与牌墙剩余——真正「结合新信息」继续讨论。
 */

export function mentorFollowUp(
  userText: string,
  perspective: UserPerspective,
  live?: LiveBoardContext,
): { text: string, basis?: MentorBasis } {
  const t = userText.trim()

  // 1) 提牌张：匹配 1-9 万筒条 或 字牌
  const tile = t.match(/[1-9][万筒条]|[东南西北中发白]/)?.[0]
  if (tile) {
    if (live?.tileCounts && live.tileCounts[tile] !== undefined) {
      const shown = live.tileCounts[tile]
      const wall = live.wallLeft !== undefined ? `牌墙还余 ${live.wallLeft} 张` : ''
      return {
        text: `你点到的 ${tile} 是个具体信号——目前场上已现 ${shown} 张，${wall}。它越稀缺越值得盯：结合你想要的牌型，看这张是帮你进张还是卡你听。`,
      }
    }
    return {
      text: `你点到的 ${tile} 是个具体信号。把它摆进你的牌型里算一遍：是帮你进张还是卡你听？等下一手牌打出来，我拿实时现张数再跟你回。`,
    }
  }

  // 2) 要依据
  if (/凭什么|凭啥|依据|为什么|道理|证据|理由|咋判断/.test(t)) {
    const b = perspective.mentorBasis
    if (b) {
      const parts = [
        b.ruleName ? `依据来自「${b.ruleName}」` : '',
        b.confidence !== undefined ? `置信度 ${(b.confidence * 100).toFixed(0)}%` : '',
        b.evidenceCount !== undefined ? `${b.evidenceCount} 个实战实例支撑` : '',
        b.rationale ? `破晓哥原话：「${b.rationale}」` : '',
      ].filter(Boolean)
      return {
        text: `我的依据摆给你：${parts.join('；')}。你要是不服，举一个反例——只要有一手牌它不成立，我就记下来跟你一起改。`,
        basis: b,
      }
    }
    return {
      text: `这条我没绑到具体规则，拿不出对等硬依据，只能记为通用角度。你有具体反例就甩给我，咱们对。`,
    }
  }

  // 3) 问边界
  if (/边界|什么时候不成立|什么情况|例外|不成立|反过来|反过来赢/.test(t)) {
    const b = perspective.mentorBasis
    if (b?.boundary) {
      return {
        text: `边界在这：「${b.boundary}」。落在边界外你的角度就成立、我采纳；还在边界里我仍按原话给判断。把那手牌摊开，咱们看它站在哪一边。`,
        basis: b,
      }
    }
    return {
      text: `这条规则没标边界，等于「多数情况都适用」。你若想到一个它不成立的局面，正好补成边界——说说看？`,
    }
  }

  // 4) 默认承接：复述立场、邀请摊牌；若刚有牌打出则点出"新信息"
  const stanceLine = perspective.mentorLine ? `我方立场：${perspective.mentorLine}。` : ''
  const evoHint = live?.lastDiscard ? `刚打出的 ${live.lastDiscard} 是个新信息——` : ''
  return {
    text: `${evoHint}${stanceLine}你说具体点：把那手牌的牌面摊开（谁打了什么、你手里什么），我拿实时现张和你的牌型陪你逐张对。你给反例，我记。`,
  }
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
