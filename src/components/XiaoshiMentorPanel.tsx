import type { GameState } from '../game/types'
import type { PerspectiveStatus, UserPerspective } from '../knowledge/xiaoshiDissent'
import type { DecisionTheme, MentorStance } from '../knowledge/xiaoshiTypes'
// 理由解释面板（UI 层）
// 与出牌建议并列展示：主线教练给主决策，这里只补经验规则、依据与边界——
// 命中规则时输出一句话观点 + 理由原话 + 边界条件 + 可核验证据；未命中则保持安静。
// 赛中互动：每张建议可「我有不同意见」开聊，导师把你的角度记进 localStorage，
// 之后同类局面会多出一个「你的思考角度」；底部「讨论记录」可标状态形成相互成长闭环。
import { useMemo, useState } from 'react'
import { buildXiaoshiAdvice } from '../knowledge/xiaoshiAdvisor'
import { XIAOSHI_CASES } from '../knowledge/xiaoshiCases'
import {
  addPerspective,
  loadPerspectives,

  setPerspectiveStatus,
  toUserAngles,

} from '../knowledge/xiaoshiDissent'
import { XIAOSHI_RULES } from '../knowledge/xiaoshiRules'

const WINDOW_LABEL: Record<'response' | 'discard' | 'any', string> = {
  response: '碰/杠/胡响应',
  discard: '出牌',
  any: '读牌观察',
}

const STATUS_LABEL: Record<PerspectiveStatus, string> = {
  open: '待消化',
  accepted: '已纳入',
  kept: '保留异议',
}

/** 导师立场标签——导师也要有自己的不同意见，不当应声虫 */
const STANCE_LABEL: Record<MentorStance, string> = {
  agree: '导师认同',
  partial: '导师分情况',
  hold: '导师有不同意见',
}

export function XiaoshiMentorPanel({ state }: { state: GameState }) {
  const [perspectives, setPerspectives] = useState<UserPerspective[]>(() => loadPerspectives())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [composerFor, setComposerFor] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [generalDraft, setGeneralDraft] = useState('')

  const angles = useMemo(() => toUserAngles(perspectives), [perspectives])
  const advice = useMemo(() => buildXiaoshiAdvice(state, 0, { userAngles: angles }), [state, angles])

  function submitDissent(ruleId: string, theme: DecisionTheme | null) {
    const text = draft.trim()
    if (!text)
      return
    const p = addPerspective({ ruleId, theme, text })
    setPerspectives(prev => [...prev, p])
    setDraft('')
    setComposerFor(null)
  }

  function toggleStatus(id: string, status: PerspectiveStatus) {
    const updated = setPerspectiveStatus(id, status)
    if (updated)
      setPerspectives(prev => prev.map(p => (p.id === id ? updated : p)))
  }

  function submitGeneral() {
    const text = generalDraft.trim()
    if (!text)
      return
    const p = addPerspective({ ruleId: null, theme: null, text })
    setPerspectives(prev => [...prev, p])
    setGeneralDraft('')
  }

  return (
    <section className="xiaoshi-panel" aria-label="我的决策 · 理由解释">
      <div className="xiaoshi-heading">
        <span className="eyebrow">理由解释</span>
        <h3>实战风格提示</h3>
        <p>
          {XIAOSHI_CASES.length}
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
                {[...perspectives].reverse().map(p => (
                  <li key={p.id} className={`discuss-item discuss-${p.status}`}>
                    <p className="discuss-text">{p.text}</p>
                    <div className="discuss-meta">
                      <span className="discuss-scope">{p.ruleId ? p.ruleId : p.theme ? p.theme : '通用'}</span>
                      <span className={`discuss-status status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                      <span className={`xiaoshi-stance stance-${p.stance ?? 'partial'}`}>
                        {STANCE_LABEL[p.stance ?? 'partial']}
                      </span>
                    </div>
                    {p.mentorNote && (
                      <p className="discuss-mentor">
                        导师：
                        {p.mentorNote}
                      </p>
                    )}
                    {p.mentorBasis && (
                      <p className="discuss-basis">
                        {[
                          p.mentorBasis.ruleName ? `依据：${p.mentorBasis.ruleName}` : '',
                          p.mentorBasis.confidence === undefined ? '' : `置信度 ${(p.mentorBasis.confidence * 100).toFixed(0)}%`,
                          p.mentorBasis.evidenceCount === undefined ? '' : `${p.mentorBasis.evidenceCount} 个实例`,
                          p.mentorBasis.boundary ? `边界：${p.mentorBasis.boundary}` : '',
                        ].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <div className="discuss-actions">
                      <button onClick={() => toggleStatus(p.id, 'accepted')} disabled={p.status === 'accepted'}>纳入导师思考</button>
                      <button onClick={() => toggleStatus(p.id, 'kept')} disabled={p.status === 'kept'}>保留异议</button>
                      <button onClick={() => toggleStatus(p.id, 'open')} disabled={p.status === 'open'}>重新打开</button>
                    </div>
                  </li>
                ))}
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
