// 经验推理导师面板（UI 层）
// 与「朱扬主线教练」(AssistantPanel) 并列展示：主线教练给主决策，这里只补「风格镜像」——
// 命中规则时输出一句话观点 + 理由原话 + 边界条件 + 可核验证据；未命中则保持安静。
import { useMemo, useState } from 'react'
import type { GameState } from '../game/types'
import { buildXiaoshiAdvice } from '../knowledge/xiaoshiAdvisor'
import { XIAOSHI_RULES } from '../knowledge/xiaoshiRules'
import { XIAOSHI_CASES } from '../knowledge/xiaoshiCases'

const WINDOW_LABEL: Record<'response' | 'discard' | 'any', string> = {
  response: '碰/杠/胡响应',
  discard: '出牌',
  any: '读牌观察',
}

export function XiaoshiMentorPanel({ state }: { state: GameState }) {
  const advice = useMemo(() => buildXiaoshiAdvice(state, 0), [state])
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section className="xiaoshi-panel" aria-label="经验推理提示">
      <div className="xiaoshi-heading">
        <span className="eyebrow">经验推理</span>
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
                    <blockquote>{item.quote}</blockquote>
                    <footer>
                      <button className="xiaoshi-toggle" onClick={() => setExpanded(open ? null : item.ruleId)}>
                        {open ? '收起依据' : '看依据与边界'}
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
                  </article>
                )
              })}
            </div>
          )}
    </section>
  )
}
