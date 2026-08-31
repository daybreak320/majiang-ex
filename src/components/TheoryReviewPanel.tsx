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
          <dt>转和空间</dt>
          <dd>{`实战 ${decision.opportunityActual} 张活张 / 更宽路线 ${decision.opportunityBest} 张`}</dd>
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
        <span className="review-highlight-score">{`活张 ${highlight.opportunity} 张`}</span>
      </div>
      {decision !== undefined && <DecisionSituation decision={decision} />}
      <p>{highlight.detail}</p>
      <FeedbackControl seed={seed} sequence={highlight.sequence} conclusionKind="highlight" />
    </article>
  )
}

function formatWaits(waits: DiscardDecision['actualWaits']): string {
  return waits.length === 0
    ? '暂无能直接推进的活张'
    : waits.map(wait => `${wait.tile.value}${wait.tile.type}×${wait.remaining}`).join(' · ')
}

function OpportunityTrend({ decisions }: { decisions: DiscardDecision[] }) {
  const evaluable = decisions.filter(decision => decision.evaluable)
  if (evaluable.length === 0)
    return <p className="muted">本局没有足够的暗手节点可比较转和空间。</p>
  const maximum = Math.max(...evaluable.map(decision => decision.opportunityActual), 1)
  const lowest = Math.min(...evaluable.map(decision => decision.opportunityActual))
  const firstLowest = evaluable.findIndex(decision => decision.opportunityActual === lowest)
  return (
    <div className="opportunity-trend">
      <div className="opportunity-summary" role="status">
        <strong>这局的空间从最多 {maximum} 张活张，走到最低 {lowest} 张。</strong>
        <span>{firstLowest > 0 ? `第 ${firstLowest + 1} 次可比出牌是当前最窄的拐点，重点看它前后的路线差异。` : '第一处可比节点已经很窄，优先保证下叫和兑现速度。'}</span>
      </div>
      <div className="opportunity-route" aria-label="每次出牌后的转和路线">
        {evaluable.map((decision, index) => {
          const loss = decision.opportunityLoss
          const isTurningPoint = index === firstLowest
          return (
            <article className={`opportunity-step ${isTurningPoint ? 'opportunity-step-turning' : ''}`} key={decision.sequence}>
              <div className="opportunity-step-rail" aria-hidden="true">
                <i style={{ height: `${Math.max(12, Math.round(decision.opportunityActual / maximum * 100))}%` }} />
                <b>{decision.opportunityActual}</b>
              </div>
              <div className="opportunity-step-copy">
                <div className="opportunity-step-heading">
                  <span>{`第 ${index + 1} 次出牌 · 牌墙剩 ${decision.wallTiles} 张`}</span>
                  {isTurningPoint && <em>空间拐点</em>}
                  {decision.isForcedDingque && <em className="forced-tag">定缺强制</em>}
                </div>
                <p><strong>{`你打了 ${decision.tile.value}${decision.tile.type}`}</strong>{loss > 0 ? `，比更宽的选择少留下 ${loss} 张活张。` : '，保住了当时最宽的转和空间。'}</p>
                <div className="opportunity-waits">
                  <span><b>实战留下</b>{formatWaits(decision.actualWaits)}</span>
                  {loss > 0 && <span><b>更宽路线</b>{formatWaits(decision.bestWaits)}{`（可改打 ${decision.bestTiles.map(tile => `${tile.value}${tile.type}`).join('、')}）`}</span>}
                </div>
              </div>
            </article>
          )
        })}
      </div>
      <p className="opportunity-footnote">活张是指：在当前公开牌与手牌条件下，摸到后能直接让手牌更接近听牌或和牌的牌。它不是胜率；对手副露、牌墙长度和安全性仍要一起看。</p>
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
          <h3>{majorIssues.length > 0 ? `本局有 ${majorIssues.length} 个优先改进点` : '本局出牌节奏整体稳健'}</h3>
          <p className="muted">结论只依据当时已经公开的牌河、副露、牌墙与手牌结构；它在比较哪条路更容易兑现，不冒充精确胜率。</p>
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
          <span>累计少留活张</span>
        </div>
        <div>
          <b>{report.stats.averageLoss.toFixed(1)}</b>
          <span>平均少留活张</span>
        </div>
      </div>
      <div className="opportunity-section">
        <div>
          <h4>转和路线图</h4>
          <p className="muted">把每次关键出牌放回当时的牌墙与活张：你保住了哪条路，又在哪一巡把空间走窄。</p>
        </div>
        <OpportunityTrend decisions={report.decisions} />
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
