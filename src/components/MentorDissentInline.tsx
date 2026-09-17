// 赛中导师 · 内联异议入口
// 放在「判断」旁边（如主线教练卡）——看到建议就能就地提不同意见，
// 导师立刻给出**有依据的立场**（认同/分情况/有不同意见），不当应声虫。
import type { UserPerspective } from '../knowledge/xiaoshiDissent'
import type { DecisionTheme, MentorStance } from '../knowledge/xiaoshiTypes'
import { useState } from 'react'
import { addPerspective } from '../knowledge/xiaoshiDissent'

/** 导师立场标签（与导师面板共用） */
export const STANCE_LABEL: Record<MentorStance, string> = {
  agree: '导师认同',
  partial: '导师分情况',
  hold: '导师有不同意见',
}

export function MentorDissentInline({
  ruleId = null,
  theme = null,
  label = '我有不同意见',
  placeholder = '跟导师说句不同意见——它会给你一个有依据的立场，不当应声虫…',
}: {
  ruleId?: string | null
  theme?: DecisionTheme | null
  label?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<UserPerspective | null>(null)

  function submit() {
    const text = draft.trim()
    if (!text)
      return
    setReply(addPerspective({ ruleId, theme, text }))
    setDraft('')
    setOpen(false)
  }

  function cancel() {
    setOpen(false)
    setDraft('')
  }

  return (
    <div className="xiaoshi-dissent-inline">
      {!open && (
        <button className="xiaoshi-dissent-btn" onClick={() => setOpen(true)}>{label}</button>
      )}
      {open && (
        <div className="xiaoshi-composer">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} placeholder={placeholder} />
          <div className="xiaoshi-composer-actions">
            <button className="xiaoshi-send" onClick={submit} disabled={!draft.trim()}>发送</button>
            <button className="xiaoshi-cancel" onClick={cancel}>取消</button>
          </div>
        </div>
      )}
      {reply && (
        <div className="xiaoshi-mentor-reply">
          <span className={`xiaoshi-stance stance-${reply.stance ?? 'partial'}`}>
            {STANCE_LABEL[reply.stance ?? 'partial']}
          </span>
          <p>{reply.mentorNote}</p>
        </div>
      )}
    </div>
  )
}
