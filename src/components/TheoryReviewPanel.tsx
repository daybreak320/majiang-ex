import type { ReviewFeedback, ReviewFeedbackVerdict } from '../game/persistence'
import type { DiscardDecision, ReviewHighlight, ReviewIssue, ReviewReport } from '../review/types'
import { useState } from 'react'
import { loadReviewFeedback, recordReviewFeedback } from '../game/persistence'
import { REVIEW_ALGORITHM_VERSION } from '../review/analyzer'
import { MajiangTile } from './MajiangTile'

const ISSUE_LABELS: Record<ReviewIssue['kind'], string> = {
  tileEfficiency: '牌效',
  attackDefense: '攻防',
  strongCombo: '结构',
  meld: '鸣牌',
}

function feedbackFor(seed: number, sequence: number, conclusionKind: string): ReviewFeedback | undefined {
  return loadReviewFeedback().find(item =>
    item.seed === seed
    && item.sequence === sequence
    && item.conclusionKind === conclusionKind)
}

function FeedbackControl({ seed, sequence, conclusionKind }: { seed: number, sequence: number, conclusionKind: string }) {
  const initial = feedbackFor(seed, sequence, conclusionKind)
  const [verdict, setVerdict] = useState<ReviewFeedbackVerdict | null>(initial?.verdict ?? null)
  const [reason, setReason] = useState(initial?.reason ?? '')

  const save = (nextVerdict: ReviewFeedbackVerdict, nextReason: string) => {
    recordReviewFeedback({
      seed,
      sequence,
      conclusionKind,
      verdict: nextVerdict,
      reason: nextReason.trim(),
      algorithmVersion: REVIEW_ALGORITHM_VERSION,
      createdAt: Date.now(),
    })
    setVerdict(nextVerdict)
  }

  return (
    <div className="review-feedback">
      <span>这条结论是否准确？</span>
      <div className="review-feedback-actions">
        <button
          className={verdict === 'accepted' ? 'feedback-selected' : ''}
          type="button"
          aria-pressed={verdict === 'accepted'}
          onClick={() => save('accepted', '')}
        >
          认可
        </button>
        <button
          className={verdict === 'rejected' ? 'feedback-selected feedback-rejected' : ''}
          type="button"
          aria-pressed={verdict === 'rejected'}
          onClick={() => save('rejected', reason)}
        >
          不认可
        </button>
      </div>
      {verdict === 'rejected' && (
        <div className="review-rejection">
          <label htmlFor={`review-reason-${seed}-${sequence}-${conclusionKind}`}>原因（选填）</label>
          <textarea
            id={`review-reason-${seed}-${sequence}-${conclusionKind}`}
            value={reason}
            maxLength={300}
            placeholder="例如：当时更看重防守，或公开牌信息不足"
            onChange={event => setReason(event.target.value)}
          />
          <button className="secondary-action compact" type="button" onClick={() => save('rejected', reason)}>
            保存原因
          </button>
        </div>
      )}
      {verdict !== null && (
        <small className="review-feedback-status" role="status">
          {verdict === 'accepted' ? '已记录为认可' : '已标记为待复核'}
        </small>
      )}
    </div>
  )
}

function DecisionSituation({ decision }: { decision: DiscardDecision }) {
  const recommended = [...new Map(decision.bestTiles.map(tile => [`${tile.type}-${tile.value}`, tile])).values()]
  return (
    <div className="review-situation">
      <div className="review-tile-row">
        <span>当时手牌</span>
        <div>{decision.handBefore.map(tile => <MajiangTile tile={tile} key={tile.id} small />)}</div>
      </div>
      {decision.visible.length > 0 && (
        <div className="review-tile-row public-tiles">
          <span>桌面已公开</span>
          <div>{decision.visible.map((tile, index) => <MajiangTile tile={tile} key={`${tile.type}-${tile.value}-${index}`} small />)}</div>
        </div>
      )}
      <dl className="review-comparison">
        <div>
          <dt>你的选择</dt>
          <dd>{`${decision.tile.value}${decision.tile.type}`}</dd>
        </div>
        <div>
          <dt>推荐选择</dt>
          <dd>{recommended.length > 0 ? recommended.map(tile => `${tile.value}${tile.type}`).join('、') : '当前约束下无可比候选'}</dd>
        </div>
        <div>
          <dt>机会数</dt>
          <dd>{`${decision.opportunityActual} / 最优 ${decision.opportunityBest}`}</dd>
        </div>
        <div>
          <dt>局面阶段</dt>
          <dd>{`${decision.isLateGame ? '尾盘' : '前中盘'}${decision.isForcedDingque ? ' · 定缺强制' : ''}`}</dd>
        </div>
      </dl>
    </div>
  )
}

function IssueConclusion({ issue, decision, seed, index }: { issue: ReviewIssue, decision: DiscardDecision | undefined, seed: number, index: number }) {
  return (
    <article className="review-focus-item issue-conclusion">
      <div className="review-focus-heading">
        <div>
          <span className="review-focus-index">{`主要问题 ${index + 1}`}</span>
          <h4>{issue.title}</h4>
        </div>
        <span className="review-severity">{`${ISSUE_LABELS[issue.kind]} · 严重度 ${issue.severity}/5`}</span>
      </div>
      {decision !== undefined && <DecisionSituation decision={decision} />}
      <p>{issue.detail}</p>
      <FeedbackControl seed={seed} sequence={issue.sequence} conclusionKind={issue.kind} />
    </article>
  )
}

function HighlightConclusion({ highlight, decision, seed }: { highlight: ReviewHighlight, decision: DiscardDecision | undefined, seed: number }) {
  return (
    <article className="review-focus-item highlight-conclusion">
      <div className="review-focus-heading">
        <div>
          <span className="review-focus-index">优秀决策</span>
          <h4>{highlight.title}</h4>
        </div>
        <span className="review-highlight-score">{`机会数 ${highlight.opportunity}`}</span>
      </div>
      {decision !== undefined && <DecisionSituation decision={decision} />}
      <p>{highlight.detail}</p>
      <FeedbackControl seed={seed} sequence={highlight.sequence} conclusionKind="highlight" />
    </article>
  )
}

function OpportunityTrend({ values }: { values: number[] }) {
  if (values.length === 0)
    return <p className="muted">本局没有可绘制的机会数数据。</p>
  const maximum = Math.max(...values, 1)
  return (
    <div className="opportunity-trend">
      <div className="opportunity-chart" aria-label={`各次出牌机会数：${values.join('、')}`} role="img">
        {values.map((value, index) => (
          <span className="opportunity-column" key={`${index}-${value}`} title={`第 ${index + 1} 次出牌：${value} 个机会`}>
            <i style={{ height: `${Math.max(6, Math.round(value / maximum * 100))}%` }} />
            <b>{value}</b>
            <small>{index + 1}</small>
          </span>
        ))}
      </div>
      <div className="opportunity-axis">
        <span>机会数</span>
        <span>出牌次序</span>
      </div>
    </div>
  )
}

export function TheoryReviewPanel({ report, seed }: { report: ReviewReport, seed: number }) {
  const decisionBySequence = new Map(report.decisions.map(decision => [decision.sequence, decision]))
  const { majorIssues, goodDecision } = report.summary
  return (
    <section className="settlement-card theory-review">
      <div className="theory-review-header">
        <div>
          <span className="eyebrow">朱扬理论复盘</span>
          <h3>{majorIssues.length > 0 ? `本局有 ${majorIssues.length} 个优先改进点` : '本局牌效决策整体稳健'}</h3>
          <p className="muted">基于当时可见信息的机会数近似评估，不代表精确期望值。</p>
        </div>
        <span className="review-version">{REVIEW_ALGORITHM_VERSION}</span>
      </div>
      <div className="theory-review-stats">
        <div>
          <b>{report.stats.decisions}</b>
          <span>已分析出牌</span>
        </div>
        <div>
          <b>{report.stats.totalLoss}</b>
          <span>累计机会数损失</span>
        </div>
        <div>
          <b>{report.stats.averageLoss.toFixed(1)}</b>
          <span>平均机会数损失</span>
        </div>
      </div>
      <div className="opportunity-section">
        <div>
          <h4>机会数趋势</h4>
          <p className="muted">每次出牌后保留的有效进张数量</p>
        </div>
        <OpportunityTrend values={report.stats.opportunityTrend} />
      </div>
      <div className="review-focus-list">
        {majorIssues.map((issue, index) => (
          <IssueConclusion
            issue={issue}
            decision={decisionBySequence.get(issue.sequence)}
            seed={seed}
            index={index}
            key={`${issue.sequence}-${issue.kind}`}
          />
        ))}
        {majorIssues.length === 0 && <p className="review-empty">没有达到严重阈值的主要问题，继续保持当前的结构判断。</p>}
        {goodDecision === null
          ? <p className="review-empty">本局暂无达到代表性阈值的优秀决策。</p>
          : <HighlightConclusion highlight={goodDecision} decision={decisionBySequence.get(goodDecision.sequence)} seed={seed} />}
      </div>
    </section>
  )
}
