import type { GameState } from '../game/types'
import type { LiveBoardContext, UserPerspective } from '../knowledge/xiaoshiDissent'
import type { DecisionCase, DecisionTheme } from '../knowledge/xiaoshiTypes'
// 理由解释面板（UI 层）
// 与出牌建议并列展示：主线教练给主决策，这里只补经验规则、依据与边界——
// 命中规则时输出一句话观点 + 理由原话 + 边界条件 + 可核验证据；未命中则保持安静。
// 赛中互动：每张建议可「我有不同意见」开聊，导师把你的角度记进 localStorage，
// 之后同类局面会多出一个「你的思考角度」；对谈是一条可多轮推进的线程，
// 导师还会随牌局推进结合新信息主动回看，局末可一键沉淀为经验卡候选。
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildXiaoshiAdvice } from '../knowledge/xiaoshiAdvisor'
import { ALL_XIAOSHI_CASES, getCasesByTheme } from '../knowledge/xiaoshiKnowledge'
import {
  addPerspective,
  addTurn,
  buildStageTalk,
  CHANGE_EVENT,
  computeMentorProgress,
  loadPerspectives,
  loadSeenStage,
  markStageSeen,
  mentorFollowUp,
  perspectiveTurns,
  recordEvolve,
  setPerspectiveStatus,
  toUserAngles,
} from '../knowledge/xiaoshiDissent'
import { XIAOSHI_RULES } from '../knowledge/xiaoshiRules'
import { STANCE_LABEL } from './MentorDissentInline'

const WINDOW_LABEL: Record<'response' | 'discard' | 'any', string> = {
  response: '碰/杠/胡响应',
  discard: '出牌',
  any: '读牌观察',
}

const STATUS_LABEL: Record<UserPerspective['status'], string> = {
  open: '待消化',
  accepted: '已纳入',
  kept: '保留异议',
}

/** 从当前牌面算出实时上下文，喂给本地讨论引擎做「结合新信息」的接招/跟评 */
function computeLive(state: GameState): LiveBoardContext {
  const all = state.players.flatMap(p => p.discards)
  const tileCounts: Record<string, number> = {}
  for (const t of all) {
    const k = `${t.value}${t.type}`
    tileCounts[k] = (tileCounts[k] ?? 0) + 1
  }
  const last = all.length > 0 ? all[all.length - 1] : undefined
  return {
    tick: state.nextEventSequence,
    tileCounts,
    wallLeft: state.wall.length,
    lastDiscard: last ? `${last.value}${last.type}` : undefined,
  }
}

function basisSnippet(basis: UserPerspective['mentorBasis']) {
  if (!basis)
    return null
  return [
    basis.ruleName ? `依据：${basis.ruleName}` : '',
    basis.confidence === undefined ? '' : `置信度 ${(basis.confidence * 100).toFixed(0)}%`,
    basis.evidenceCount === undefined ? '' : `${basis.evidenceCount} 实例`,
    basis.boundary ? `边界：${basis.boundary}` : '',
  ].filter(Boolean).join(' · ')
}

export function XiaoshiMentorPanel({ state, gameId = null }: { state: GameState, gameId?: string | null }) {
  const [perspectives, setPerspectives] = useState<UserPerspective[]>(() => loadPerspectives())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [composerFor, setComposerFor] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [generalDraft, setGeneralDraft] = useState('')
  const [seenStage, setSeenStage] = useState(() => loadSeenStage())
  const [expandedThread, setExpandedThread] = useState<string | null>(null)
  const [threadDraft, setThreadDraft] = useState('')
  const [threadDraftFor, setThreadDraftFor] = useState<string | null>(null)

  const angles = useMemo(() => toUserAngles(perspectives), [perspectives])
  const progress = useMemo(() => computeMentorProgress(perspectives), [perspectives])
  // 攒够分值晋升新段位 → 弹一次「阶段对谈」；看过就记下，不重复打扰
  const stageUnlocked = progress.level > seenStage

  function acknowledgeStage() {
    markStageSeen(progress.level)
    setSeenStage(progress.level)
  }
  const advice = useMemo(() => buildXiaoshiAdvice(state, 0, { userAngles: angles }), [state, angles])

  // 每条建议按主题挂「相关实战案例」（合并池 837 卡，含邂逅 621），最多 2 条；
  // 排除与规则原话完全相同的，避免重复。仅作延伸阅读，不抢主决策。
  const relatedCases = useMemo(() => {
    const m = new Map<string, DecisionCase[]>()
    for (const item of advice) {
      if (!item.theme)
        continue
      const rel = getCasesByTheme(item.theme)
        .filter(c => (c.reasonQuotes[0] ?? '') !== item.quote)
        .slice(0, 2)
      if (rel.length)
        m.set(item.ruleId, rel)
    }
    return m
  }, [advice])

  // 其他入口（如教练卡内联异议）写入后同步重读，避免多面板状态不一致
  useEffect(() => {
    if (typeof window === 'undefined')
      return
    const reload = () => setPerspectives(loadPerspectives())
    window.addEventListener(CHANGE_EVENT, reload)
    return () => window.removeEventListener(CHANGE_EVENT, reload)
  }, [])

  // 演进跟评：随牌局推进，导师对本局已开聊的线程结合新信息主动回看。
  // 触发条件：有新牌打出（discards 数变化）且线程 evolveCount<2（每线程每局限 2 次）。
  const lastGameIdRef = useRef<string | null>(null)
  const lastSeenDiscardsRef = useRef(-1)
  useEffect(() => {
    if (!gameId)
      return
    // 新局：重置跟评基线，不立即跟评，等下一手牌
    if (lastGameIdRef.current !== gameId) {
      lastGameIdRef.current = gameId
      lastSeenDiscardsRef.current = -1
      return
    }
    const discardCount = state.players.reduce((n, pl) => n + pl.discards.length, 0)
    if (lastSeenDiscardsRef.current === discardCount)
      return
    lastSeenDiscardsRef.current = discardCount
    const live = computeLive(state)
    let changed = false
    for (const p of loadPerspectives()) {
      if (p.gameId !== gameId)
        continue
      if ((p.evolveCount ?? 0) >= 2)
        continue
      if (perspectiveTurns(p).length < 2)
        continue // 用户还没开聊（至少一轮对谈），不主动跟
      const reply = mentorFollowUp(`结合最新牌面，${live.lastDiscard ?? '有新牌打出'}`, p, live)
      addTurn(p.id, {
        role: 'mentor',
        text: reply.text,
        ...(reply.basis ? { basis: reply.basis } : {}),
        atTick: live.tick,
      })
      recordEvolve(p.id)
      changed = true
    }
    if (changed)
      setPerspectives(loadPerspectives())
  }, [state, gameId])

  function submitDissent(ruleId: string, theme: DecisionTheme | null) {
    const text = draft.trim()
    if (!text)
      return
    const p = addPerspective({ ruleId, theme, text, gameId })
    setPerspectives(prev => [...prev, p])
    setDraft('')
    setComposerFor(null)
  }

  function toggleStatus(id: string, status: UserPerspective['status']) {
    const updated = setPerspectiveStatus(id, status)
    if (updated)
      setPerspectives(prev => prev.map(p => (p.id === id ? updated : p)))
  }

  function continueThread(id: string) {
    const p = perspectives.find(x => x.id === id)
    const text = threadDraft.trim()
    if (!p || !text)
      return
    const live = computeLive(state)
    addTurn(id, { role: 'user', text })
    const reply = mentorFollowUp(text, p, live)
    addTurn(id, {
      role: 'mentor',
      text: reply.text,
      ...(reply.basis ? { basis: reply.basis } : {}),
    })
    setThreadDraft('')
    setThreadDraftFor(null)
    setPerspectives(loadPerspectives())
  }

  function toggleThread(id: string) {
    setExpandedThread(prev => (prev === id ? null : id))
  }

  function submitGeneral() {
    const text = generalDraft.trim()
    if (!text)
      return
    const p = addPerspective({ ruleId: null, theme: null, text, gameId })
    setPerspectives(prev => [...prev, p])
    setGeneralDraft('')
  }

  return (
    <section className="xiaoshi-panel" aria-label="我的决策 · 理由解释">
      <div className="xiaoshi-heading">
        <span className="eyebrow">理由解释</span>
        <h3>实战风格提示</h3>
        <div className="mentor-rank">
          <span className="mentor-rank-badge">{`Lv${progress.level} · ${progress.title}`}</span>
          <small>
            {progress.nextThreshold === null
              ? '已到顶段 · 继续交锋只涨分不涨段'
              : `段位分 ${progress.score}/${progress.nextThreshold} · 再攒 ${progress.nextThreshold - progress.score} 分晋升`}
          </small>
        </div>
        <p>
          {ALL_XIAOSHI_CASES.length}
          {' '}
          张决策卡 ·
          {XIAOSHI_RULES.length}
          {' '}
          条规则中，当前局面命中
          <b>{advice.length}</b>
          {' '}
          条；只在有可核验依据时开口。
          {perspectives.length > 0 && (
            <>
              {' '}
              <b>{perspectives.length}</b>
              {' '}
              条你的不同意见导师已记住。
            </>
          )}
        </p>
      </div>

      {stageUnlocked && (
        <section className="mentor-stage-talk" aria-label="导师阶段对谈">
          <span className="mentor-stage-eyebrow">进阶对谈 · 段位晋升</span>
          <b>{`Lv${progress.level} ${progress.title}`}</b>
          <p>{buildStageTalk(progress)}</p>
          <button className="xiaoshi-send" onClick={acknowledgeStage}>记下了，继续</button>
        </section>
      )}

      {advice.length === 0
        ? (
            <p className="xiaoshi-silent">这手没有可核验的信号，导师保持安静——不抢主决策。</p>
          )
        : (
            <div className="xiaoshi-list">
              {advice.map((item) => {
                const open = expanded === item.ruleId
                return (
                  <article className={`xiaoshi-card xiaoshi-${item.windowKind}`} key={item.ruleId}>
                    <div className="xiaoshi-card-head">
                      <span className="xiaoshi-window">{WINDOW_LABEL[item.windowKind]}</span>
                      <b>{item.headline}</b>
                    </div>
                    <p>{item.advice}</p>
                    <span className="xiaoshi-quote-badge">破晓哥原话 · 案例</span>
                    <blockquote>{item.quote}</blockquote>
                    {item.quoteBridge && <p className="xiaoshi-bridge">{item.quoteBridge}</p>}
                    {(relatedCases.get(item.ruleId) ?? []).map(c => (
                      <div className="xiaoshi-related" key={c.id}>
                        <span className="xiaoshi-quote-badge">相关实战案例</span>
                        <blockquote>{c.reasonQuotes[0]}</blockquote>
                        {c.source && (
                          <small style={{ opacity: 0.6, fontSize: '11px' }}>
                            {c.source.title} · 原片 t={c.source.t}s
                          </small>
                        )}
                      </div>
                    ))}
                    {item.userAngles && item.userAngles.length > 0 && (
                      <div className="xiaoshi-angles">
                        <span className="xiaoshi-angles-label">你的思考角度</span>
                        <ul>
                          {item.userAngles.map(a => (
                            <li key={a.id}>
                              <span className="xiaoshi-angle-text">{a.text}</span>
                              <span className={`xiaoshi-stance stance-${a.stance ?? 'partial'}`}>
                                {STANCE_LABEL[a.stance ?? 'partial']}
                                {a.mentorLine ? `：${a.mentorLine}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <footer>
                      <button className="xiaoshi-toggle" onClick={() => setExpanded(open ? null : item.ruleId)}>
                        {open ? '收起依据' : '看依据与边界'}
                      </button>
                      <button className="xiaoshi-dissent-btn" onClick={() => setComposerFor(item.ruleId)}>
                        我有不同意见
                      </button>
                      <small>
                        {item.ruleName}
                        {' · 置信度 '}
                        {(item.confidence * 100).toFixed(0)}
                        %
                      </small>
                    </footer>
                    {open && (
                      <div className="xiaoshi-detail">
                        <div className="xiaoshi-evidence">
                          <span>可核验依据</span>
                          <ul>{item.evidence.map(line => <li key={line}>{line}</li>)}</ul>
                        </div>
                        {item.boundary !== null && (
                          <div className="xiaoshi-boundary">
                            <span>边界</span>
                            <p>{item.boundary}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {composerFor === item.ruleId && (
                      <div className="xiaoshi-composer">
                        <textarea
                          value={draft}
                          onChange={e => setDraft(e.target.value)}
                          placeholder="说说你的不同意见或补充思路，导师会记住这个角度…"
                          rows={3}
                        />
                        <div className="xiaoshi-composer-actions">
                          <button
                            className="xiaoshi-send"
                            onClick={() => submitDissent(item.ruleId, item.theme)}
                            disabled={!draft.trim()}
                          >
                            记录并讨论
                          </button>
                          <button className="xiaoshi-cancel" onClick={() => setComposerFor(null)}>
                            取消
                          </button>
                        </div>
                        <p className="xiaoshi-composer-hint">
                          关联建议：
                          {item.ruleName}
                        </p>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}

      <section className="xiaoshi-discuss" aria-label="讨论记录">
        <h4>
          讨论记录 · 导师记得（
          {perspectives.length}
          ）
        </h4>
        {perspectives.length === 0
          ? (
              <p className="xiaoshi-discuss-empty">
                还没跟导师交过锋。遇到不认同的建议，点「我有不同意见」就能开聊——导师会记住你的角度，下次同类局面多一个思考维度。
              </p>
            )
          : (
              <ul className="xiaoshi-discuss-list">
                {[...perspectives].reverse().map(p => {
                  const turns = perspectiveTurns(p)
                  const open = expandedThread === p.id
                  const scope = p.ruleId ? p.ruleId : p.theme ? p.theme : '通用'
                  return (
                    <li key={p.id} className={`discuss-item discuss-${p.status} ${p.distilled ? `distilled-${p.distilled}` : ''}`}>
                      <button className="discuss-summary" onClick={() => toggleThread(p.id)} aria-expanded={open}>
                        <span className="discuss-text">{p.text}</span>
                        <span className="discuss-meta">
                          <span className="discuss-scope">{scope}</span>
                          <span className={`discuss-status status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                          <span className={`xiaoshi-stance stance-${p.stance ?? 'partial'}`}>
                            {STANCE_LABEL[p.stance ?? 'partial']}
                          </span>
                          {p.gameId && <small className="discuss-game">本局</small>}
                          {p.evolveCount ? <small className="discuss-evo">跟评 {p.evolveCount}/2</small> : null}
                          {p.distilled === 'saved' && <small className="discuss-distilled">已沉淀</small>}
                        </span>
                      </button>
                      {open && (
                        <div className="discuss-thread">
                          <div className="xiaoshi-bubbles">
                            {turns.map((t, i) => {
                              const snip = t.basis && t.role === 'mentor' ? basisSnippet(t.basis) : null
                              return (
                                <div className={`xiaoshi-bubble bubble-${t.role}`} key={i}>
                                  <span className="bubble-role">{t.role === 'user' ? '你' : '导师'}</span>
                                  <p>{t.text}</p>
                                  {snip && <small className="bubble-basis">{snip}</small>}
                                </div>
                              )
                            })}
                          </div>
                          <div className="xiaoshi-composer xiaoshi-composer-continue">
                            <textarea
                              value={threadDraftFor === p.id ? threadDraft : ''}
                              onChange={(e) => {
                                setThreadDraftFor(p.id)
                                setThreadDraft(e.target.value)
                              }}
                              placeholder="继续讨论：点具体牌张、问依据或边界，导师接着跟你拆…"
                              rows={2}
                            />
                            <div className="xiaoshi-composer-actions">
                              <button className="xiaoshi-send" onClick={() => continueThread(p.id)} disabled={!threadDraft.trim()}>
                                接着说
                              </button>
                            </div>
                          </div>
                          <div className="discuss-actions">
                            <button onClick={() => toggleStatus(p.id, 'accepted')} disabled={p.status === 'accepted'}>纳入导师思考</button>
                            <button onClick={() => toggleStatus(p.id, 'kept')} disabled={p.status === 'kept'}>保留异议</button>
                            <button onClick={() => toggleStatus(p.id, 'open')} disabled={p.status === 'open'}>重新打开</button>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
        <div className="xiaoshi-composer xiaoshi-composer-general">
          <textarea
            value={generalDraft}
            onChange={e => setGeneralDraft(e.target.value)}
            placeholder="随时跟导师说句不同意见（通用角度，不绑定某条规则）…"
            rows={2}
          />
          <button className="xiaoshi-send" onClick={submitGeneral} disabled={!generalDraft.trim()}>发送</button>
        </div>
      </section>
    </section>
  )
}
