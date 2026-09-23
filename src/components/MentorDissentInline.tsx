// 赛中导师 · 内联异议入口（多轮对谈版）
// 看到建议就能就地提不同意见，提交后不收起——导师给有依据的立场，
// 你可以继续发，导师按「提牌张 / 要依据 / 问边界」接招，形成多轮对谈线程。
// 导师还会随牌局推进在「理由解释」面板结合新信息主动回看这条线程。
import type { UserPerspective } from '../knowledge/xiaoshiDissent'
import type { DecisionTheme, MentorStance } from '../knowledge/xiaoshiTypes'
import { useEffect, useState } from 'react'
import {
  addPerspective,
  addTurn,
  CHANGE_EVENT,
  loadPerspectives,
  mentorFollowUp,
  perspectiveTurns,
} from '../knowledge/xiaoshiDissent'

/** 导师立场标签（与导师面板共用） */
export const STANCE_LABEL: Record<MentorStance, string> = {
  agree: '导师认同',
  partial: '导师分情况',
  hold: '导师有不同意见',
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

export function MentorDissentInline({
  ruleId = null,
  theme = null,
  gameId = null,
  label = '我有不同意见',
  placeholder = '跟导师说句不同意见——它会给你一个有依据的立场，不当应声虫…',
}: {
  ruleId?: string | null
  theme?: DecisionTheme | null
  gameId?: string | null
  label?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [thread, setThread] = useState<UserPerspective | null>(null)
  const [continueDraft, setContinueDraft] = useState('')

  // 导师在面板主动回看（结合新信息）后，线程会变化 —— 监听广播刷新本地视图
  useEffect(() => {
    if (!thread)
      return
    if (typeof window === 'undefined')
      return
    const reload = () => {
      const found = loadPerspectives().find(p => p.id === thread.id)
      if (found)
        setThread(found)
    }
    window.addEventListener(CHANGE_EVENT, reload)
    return () => window.removeEventListener(CHANGE_EVENT, reload)
  }, [thread])

  function submit() {
    const text = draft.trim()
    if (!text)
      return
    const p = addPerspective({ ruleId, theme, text, gameId })
    setThread(p)
    setDraft('')
    // 不收起：就地展开对谈线程
  }

  function continueDiscuss() {
    if (!thread)
      return
    const text = continueDraft.trim()
    if (!text)
      return
    addTurn(thread.id, { role: 'user', text })
    const reply = mentorFollowUp(text, thread)
    const updated = addTurn(thread.id, {
      role: 'mentor',
      text: reply.text,
      ...(reply.basis ? { basis: reply.basis } : {}),
    })
    if (updated)
      setThread(updated)
    setContinueDraft('')
  }

  function reset() {
    setOpen(false)
    setThread(null)
    setDraft('')
    setContinueDraft('')
  }

  // 渲染用的对谈轨迹：统一走 perspectiveTurns（新数据用 turns，旧 localStorage 回退到 text/mentorNote）
  const turns = thread ? perspectiveTurns(thread) : []

  return (
    <div className="xiaoshi-dissent-inline">
      {!open && !thread && (
        <button className="xiaoshi-dissent-btn" onClick={() => setOpen(true)}>{label}</button>
      )}
      {open && !thread && (
        <div className="xiaoshi-composer">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} placeholder={placeholder} />
          <div className="xiaoshi-composer-actions">
            <button className="xiaoshi-send" onClick={submit} disabled={!draft.trim()}>发送</button>
            <button className="xiaoshi-cancel" onClick={reset}>取消</button>
          </div>
        </div>
      )}
      {thread && (
        <div className="xiaoshi-thread">
          <div className="xiaoshi-thread-head">
            <span className="eyebrow">对谈中</span>
            {thread.stance && (
              <span className={`xiaoshi-stance stance-${thread.stance}`}>{STANCE_LABEL[thread.stance]}</span>
            )}
            <button className="xiaoshi-thread-close" onClick={reset} aria-label="收起对谈">×</button>
          </div>
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
              value={continueDraft}
              onChange={e => setContinueDraft(e.target.value)}
              rows={2}
              placeholder="继续讨论：点具体牌张、问依据或边界，导师接着跟你拆…"
            />
            <div className="xiaoshi-composer-actions">
              <button className="xiaoshi-send" onClick={continueDiscuss} disabled={!continueDraft.trim()}>接着说</button>
              <button className="xiaoshi-cancel" onClick={reset}>收起</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
