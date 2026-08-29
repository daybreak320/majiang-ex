import type { GameHistoryEntry } from '../game/persistence'
import type { GameState, LegalAction, PlayerId, TileInstance } from '../game/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { advanceAIOnce } from '../game/ai'
import type { DiscardCandidateAnalysis } from '../game/assistant'
import { buildCandidateLesson, buildDiscardAssistant, buildHuLesson, buildPengLesson } from '../game/assistant'
import { createInitialGame, createSpecialTrainingGame, recommendDingque, SPECIAL_TRAINING_META } from '../game/core'
import type { SpecialTrainingKind } from '../game/core'
import { executeCommand, getLegalActions, getTimeoutCommand } from '../game/engine'
import { clearUnfinishedGame, loadGameHistory, recordFinishedGame, saveUnfinishedGame } from '../game/persistence'
import { AI_STYLE_LABELS, buildEventTimeline, buildGameReview, buildHistoryInsight, buildSettlementSummary, buildTheoryHistoryEntry, formatGameEvent, MELD_LABELS, PLAYER_NAMES, SCORE_REASON_LABELS } from '../game/presentation'
import { buildStrategicReminder, detectOpponentThreats } from '../game/strategy'
import { getTurnTimerDuration, shouldAdvanceAI } from '../game/ui'
import { analyzeGame } from '../review/analyzer'
import { MajiangTile } from './MajiangTile'

interface SichuanGameProps {
  seed: number
  restoredState?: GameState
  timedTraining: boolean
  trainingKind?: SpecialTrainingKind
  onHome: () => void
  onNewGame: () => void
}

const PLAYER_POSITIONS = ['south', 'west', 'north', 'east'] as const

function tileLabel(tile: Pick<TileInstance, 'type' | 'value'>): string {
  return `${tile.value}${tile.type}`
}

function MiniTile({ tile }: { tile: TileInstance }) {
  return <MajiangTile tile={tile} small />
}

function PlayerPanel({ state, playerId, thinking }: { state: GameState, playerId: PlayerId, thinking: PlayerId | null }) {
  const player = state.players[playerId]
  return (
    <section className={`player-panel player-${PLAYER_POSITIONS[playerId]} ${state.currentPlayer === playerId && state.phase === 'discarding' ? 'active-player' : ''}`}>
      <div className="player-heading">
        <div>
          <strong>{PLAYER_NAMES[playerId]}</strong>
          {playerId === state.dealer && <span className="dealer-badge">庄</span>}
        </div>
        <strong className={player.score >= 0 ? 'positive-score' : 'negative-score'}>
          {player.score >= 0 ? '+' : ''}
          {player.score}
        </strong>
      </div>
      <div className="player-meta">
        <span>{playerId === 0 ? '真人玩家' : AI_STYLE_LABELS[player.aiStyle!]}</span>
        <span>
          定缺
          {player.dingque ?? '—'}
        </span>
        <span>{player.hasWon ? `已胡 · ${player.winInfo?.fan ?? 0}番` : `${player.hand.length}张`}</span>
        {thinking === playerId && <span className="thinking">思考中…</span>}
      </div>
      {player.melds.length > 0 && (
        <div className="meld-list">
          {player.melds.map((meld, index) => (
            <div className="meld" key={`${meld.tiles[0].id}-${index}`}>
              <b>{MELD_LABELS[meld.kind]}</b>
              {meld.tiles.map(tile => <MiniTile key={tile.id} tile={tile} />)}
            </div>
          ))}
        </div>
      )}
      {playerId !== 0 && <div className="tile-backs" aria-label={`${player.hand.length}张暗牌`}>{Array.from({ length: Math.min(player.hand.length, 14) }, (_, index) => <span key={index} />)}</div>}
      <div className="discard-river" aria-label={`${PLAYER_NAMES[playerId]}的牌河`}>{player.discards.map(tile => <MiniTile key={tile.id} tile={tile} />)}</div>
    </section>
  )
}

function ImmediateTenpaiHint({ candidate }: { candidate: DiscardCandidateAnalysis }) {
  const total = candidate.waits.reduce((sum, wait) => sum + wait.remaining, 0)
  const isSingleLive = total === 1
  const waitText = candidate.theoreticalWaits.map(wait => wait.remaining > 0
    ? `${wait.tile.value}${wait.tile.type}×${wait.remaining}`
    : `${wait.tile.value}${wait.tile.type}（理论死听·已打光）`).join('、')
  const trends = candidate.patternTrends.map(trend => trend.summary).join(' ')
  return (
    <aside className={`immediate-tenpai-hint ${isSingleLive ? 'critical-tenpai' : ''}`} aria-live="polite">
      <b>已选打 {candidate.tile.value}{candidate.tile.type} {candidate.isRecommended ? '· 当前首选' : '· 查看此方案'}</b>
      {candidate.theoreticalWaits.length > 0
        ? <span>胡 {waitText} · 实际共剩 {total} 张</span>
        : <span>暂未听牌 · 下一摸可转听 {candidate.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)} 张 · {((candidate.nextDrawTenpaiProbability ?? 0) * 100).toFixed(1)}%</span>}
      {trends && <small>做牌趋势：{trends}</small>}
      {candidate.theoreticalWaits.some(wait => wait.remaining === 0) && <strong>注意：牌型上能胡，但该叫口已被公开牌打光，属于理论死听。</strong>}
      {isSingleLive && <strong>危险：仅剩 1 张活叫，别把单钓当宽听。</strong>}
    </aside>
  )
}

function SouthPlayerPanel({ state, thinking, selectedTileId, setSelectedTileId, discardActions, discardIds, otherActions, legal, submit }: { state: GameState, thinking: PlayerId | null, setSelectedTileId: (id: string | null) => void, selectedTileId: string | null, discardActions: Extract<LegalAction, { type: 'discard' }>[], discardIds: Set<string>, otherActions: Exclude<LegalAction, { type: 'discard' | 'dingque' }>[], legal: LegalAction[], submit: (action: LegalAction) => void }) {
  const player = state.players[0]
  const analysis = useMemo(() => buildDiscardAssistant(state), [state])
  const selectedTile = player.hand.find(tile => tile.id === selectedTileId)
  const selectedCandidate = selectedTile === undefined || !discardIds.has(selectedTile.id)
    ? undefined
    : analysis.candidates.find(candidate => candidate.tile.type === selectedTile.type && candidate.tile.value === selectedTile.value)
  const selectedAction = discardActions.find(action => action.tileId === selectedTileId)
  return (
    <section className={`player-panel player-south ${state.currentPlayer === 0 && state.phase === 'discarding' ? 'active-player' : ''}`}>
      <div className="player-heading">
        <div>
          <strong>{PLAYER_NAMES[0]}</strong>
          {state.dealer === 0 && <span className="dealer-badge">庄</span>}
        </div>
        <strong className={player.score >= 0 ? 'positive-score' : 'negative-score'}>
          {player.score >= 0 ? '+' : ''}
          {player.score}
        </strong>
      </div>
      <div className="player-meta">
        <span>真人玩家</span>
        <span>
          定缺
          {player.dingque ?? '—'}
        </span>
        <span>{player.hasWon ? `已胡 · ${player.winInfo?.fan ?? 0}番` : `${player.hand.length}张`}</span>
        {thinking === 0 && <span className="thinking">思考中…</span>}
      </div>
      {player.melds.length > 0 && (
        <div className="meld-list">
          {player.melds.map((meld, index) => (
            <div className="meld" key={`${meld.tiles[0].id}-${index}`}>
              <b>{MELD_LABELS[meld.kind]}</b>
              {meld.tiles.map(tile => <MiniTile key={tile.id} tile={tile} />)}
            </div>
          ))}
        </div>
      )}
      <div className="south-hand" aria-label="你的手牌">
        {player.hand.map(tile => (
          <MajiangTile
            tile={tile}
            key={tile.id}
            selected={selectedTileId === tile.id}
            disabled={!discardIds.has(tile.id)}
            onClick={() => setSelectedTileId(tile.id)}
            onDoubleClick={() => discardIds.has(tile.id) && submit(discardActions.find(action => action.tileId === tile.id)!)}
          />
        ))}
      </div>
      {selectedCandidate !== undefined && <ImmediateTenpaiHint candidate={selectedCandidate} />}
      <div className="action-bar">
        <div className="turn-status">
          {state.phase === 'responding' && legal.length === 0
            ? '等待其他玩家响应…'
            : state.currentPlayer === 0 || legal.length > 0
              ? '请选择动作'
              : '等待 AI 行动…'}
        </div>
        {otherActions.map((action, index) => (
          <button
            className={action.type === 'hu' ? 'win-action' : 'secondary-action'}
            key={`${action.type}-${'kind' in action ? action.kind : ''}-${'tileId' in action ? action.tileId : index}`}
            onClick={() => submit(action)}
          >
            {actionLabel(action, state)}
          </button>
        ))}
        <button className="primary-action" disabled={selectedAction === undefined} onClick={() => selectedAction && submit(selectedAction)}>
          出牌
          {selectedTileId && player.hand.find(tile => tile.id === selectedTileId)
            ? ` ${tileLabel(player.hand.find(tile => tile.id === selectedTileId)!)}`
            : ''}
        </button>
      </div>
      <div className="discard-river" aria-label="你的牌河">
        {player.discards.map(tile => <MiniTile key={tile.id} tile={tile} />)}
      </div>
    </section>
  )
}

function actionLabel(action: Exclude<LegalAction, { type: 'discard' | 'dingque' }>, state: GameState): string {
  if (action.type === 'pass')
    return '过'
  if (action.type === 'hu')
    return state.phase === 'responding' ? `胡 ${action.value}分` : `自摸胡 ${action.value}分`
  if (action.type === 'peng')
    return `碰 ${tileLabel(state.responseWindow!.tile)}`
  const tile = state.players[0].hand.find(candidate => candidate.id === action.tileId) ?? state.responseWindow?.tile
  return `${MELD_LABELS[action.kind]} ${tile ? tileLabel(tile) : ''}`
}

function probabilityLabel(probability: number | null): string {
  return probability === null ? '未下叫' : `${(probability * 100).toFixed(1)}%`
}

const STRATEGY_POSTURE_LABEL = {
  retreat: '劣势快跑',
  steady: '先稳住',
  press: '优势继续贪',
} as const

function StrategicReminderPanel({ state }: { state: GameState }) {
  const reminder = useMemo(() => buildStrategicReminder(state), [state])
  const threats = useMemo(() => detectOpponentThreats(state), [state])
  return (
    <section className={`strategy-reminder strategy-${reminder.posture}`} aria-label="战略提醒">
      <div className="strategy-heading">
        <span>战略提醒</span>
        <strong>{STRATEGY_POSTURE_LABEL[reminder.posture]}</strong>
      </div>
      <div className="strategy-copy">
        <b>{reminder.title}</b>
        <p>{reminder.summary}</p>
      </div>
      <div className="strategy-signals">
        {reminder.signals.map(signal => <span key={signal}>{signal}</span>)}
        {threats.map(threat => <span className="danger-signal" key={`${threat.playerId}-${threat.targetType}`}>{threat.position}睡宽床 · 慎打{threat.targetType}</span>)}
      </div>
    </section>
  )
}

function AssistantPanel({ state, selectedTileId }: { state: GameState, selectedTileId: string | null }) {
  const analysis = useMemo(() => buildDiscardAssistant(state), [state])
  const [showTheory, setShowTheory] = useState(false)
  const [showCandidates, setShowCandidates] = useState(false)
  const [showPengLesson, setShowPengLesson] = useState(false)
  const [showHuLesson, setShowHuLesson] = useState(false)
  const selectedTile = state.players[0].hand.find(tile => tile.id === selectedTileId)
  const selectedCandidate = analysis.candidates.find(candidate => candidate.tile.type === selectedTile?.type && candidate.tile.value === selectedTile?.value)
  const lesson = selectedCandidate === undefined ? null : buildCandidateLesson(analysis, selectedCandidate)
  const pengLesson = buildPengLesson(analysis)
  const huLesson = buildHuLesson(analysis)
  const displayedLesson = showHuLesson ? huLesson : showPengLesson ? pengLesson : lesson
  return (
    <section className="assistant-panel" aria-label="实时出牌助手">
      <section className={`coach-card coach-${displayedLesson === null ? analysis.coach.mode : displayedLesson.verdict}`} aria-label="赛中导师">
        <span>{displayedLesson === null ? '赛中导师' : showHuLesson ? '胡牌取舍' : showPengLesson ? '碰牌讲解' : '手把手讲解'}</span>
        <strong>{displayedLesson?.headline ?? analysis.coach.headline}</strong>
        <p>{displayedLesson?.explanation ?? analysis.coach.guidance}</p>
        <div className="coach-evidence">{(displayedLesson?.evidence ?? analysis.coach.evidence).map(item => <b key={item}>{item}</b>)}</div>
        <small>练习：{displayedLesson?.nextQuestion ?? analysis.coach.practice}</small>
      </section>
      {huLesson !== null && (
        <button className={`peng-coach-toggle coach-${huLesson.verdict}`} onClick={() => { setShowHuLesson(current => !current); setShowPengLesson(false) }}>
          {showHuLesson ? '返回当前讲解' : `胡 ${analysis.huDecision!.points}分 · 查看胡或继续做大`}
        </button>
      )}
      {pengLesson !== null && (
        <button className={`peng-coach-toggle coach-${pengLesson.verdict}`} onClick={() => { setShowPengLesson(current => !current); setShowHuLesson(false) }}>
          {showPengLesson ? '返回当前讲解' : `碰 ${analysis.pengCandidate!.tile.value}${analysis.pengCandidate!.tile.type} · 查看碰或过分析`}
        </button>
      )}
      <div className="assistant-overview">
        <div className="assistant-recommendation">
          <span>推荐动作</span>
          <strong>{analysis.recommendationLabel}</strong>
          <p>{analysis.reason}</p>
        </div>
        <div className="assistant-probability">
          <span>{analysis.nextDrawWinProbability === null ? '当前未下叫 · 看候选入听率' : '下一张直接胡牌'}</span>
          <strong>{analysis.nextDrawWinProbability === null ? '未下叫' : probabilityLabel(analysis.nextDrawWinProbability)}</strong>
          <small>{analysis.nextDrawWinProbability === null ? '下方每种弃牌均列出下一摸入听路径与概率' : `活张 ${analysis.opportunity} / 未知牌 ${analysis.unknownTiles} · 牌墙 ${analysis.wallTiles}`}</small>
          <div className="assistant-waits">
            {analysis.waits.length === 0
              ? <span>暂无直接和牌叫口</span>
              : analysis.waits.map(wait => (
                  <span key={`${wait.tile.type}-${wait.tile.value}`}>
                    {wait.tile.value}{wait.tile.type} {wait.remaining}张 · {(wait.probability * 100).toFixed(1)}% · {wait.baseFan}番
                  </span>
                ))}
          </div>
        </div>
        <button className="assistant-theory-toggle" onClick={() => setShowTheory(current => !current)}>
          {showTheory ? '收起依据' : '展开理论依据'}
        </button>
      </div>
      {showTheory && (
        <div className="assistant-theory">
          <strong>这次推荐是怎么推出来的</strong>
          <ul>{analysis.theoryBasis.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
      <div className="assistant-candidates" aria-label="各弃牌方案的听牌收益比较">
        <div className="assistant-section-heading">
          <div><span>手牌选择 · 听牌收益对比</span><small>已听看下一摸和牌率；未听看下一摸经一次弃牌可入听的概率。均按公开牌扣张。</small></div>
          <button className="assistant-theory-toggle" onClick={() => setShowCandidates(current => !current)}>{showCandidates ? '收起选听对比' : `展开 ${analysis.candidates.length} 类选听对比`}</button>
        </div>
        {showCandidates && (analysis.candidates.length === 0
          ? <p className="muted">当前不是出牌阶段，暂不生成弃牌对比。</p>
          : analysis.candidates.map(candidate => (
              <article className={`assistant-candidate ${candidate.isRecommended ? 'recommended-candidate' : ''}`} key={`${candidate.tile.value}-${candidate.tile.type}`}>
                <div className="candidate-tile"><b>打</b><strong>{candidate.tile.value}{candidate.tile.type}</strong>{candidate.isRecommended && <small>推荐</small>}</div>
                <div><span>活张 / 叫口</span><b>{candidate.opportunity} 张 / {candidate.structuralWaits} 种</b></div>
                <div><span>{candidate.nextDrawWinProbability === null ? '下一摸入听率' : '下一摸和牌率'}</span><b>{candidate.nextDrawWinProbability === null ? probabilityLabel(candidate.nextDrawTenpaiProbability) : probabilityLabel(candidate.nextDrawWinProbability)}</b></div>
                <div><span>{candidate.averageFan === null ? '入听后番型' : '成牌基础价值'}</span><b>{candidate.averageFan === null ? '未下叫 · 摸入后定番' : `${candidate.averageFan.toFixed(1)}番 · ${Math.round(candidate.averagePoints ?? 0)}分`}</b></div>
                <div><span>{candidate.averageFan === null ? '转听进张' : '单巡性价比'}</span><b>{candidate.averageFan === null ? `${candidate.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)} 张` : candidate.valueIndex === 0 ? '—' : `${(candidate.valueIndex * 100).toFixed(1)} 指数`}</b></div>
                <p>{candidate.brokenCombos.length === 0 ? '结构：未拆强组合。' : `结构：会拆 ${candidate.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 强组合。`}</p>
                <div className="candidate-waits">
                  {candidate.waits.length > 0
                    ? candidate.waits.map(wait => <span key={`${wait.tile.value}-${wait.tile.type}`}>{wait.tile.value}{wait.tile.type}×{wait.remaining} · {wait.baseFan}番</span>)
                    : candidate.tenpaiPaths.length > 0
                      ? candidate.tenpaiPaths.map(path => <span key={`${path.tile.value}-${path.tile.type}`}>摸{path.tile.value}{path.tile.type}×{path.remaining} · {(path.probability * 100).toFixed(1)}%后可入听</span>)
                      : <span>下一摸暂无可直接转听进张</span>}
                </div>
              </article>
            )))}</div>
      <div className="assistant-known">
        <div className="assistant-known-heading">
          <span>已知牌分布</span>
          <small>已知 {analysis.knownTiles} · 牌墙 {analysis.wallTiles}</small>
        </div>
        {(['万', '条', '筒'] as const).map(type => (
          <div className="known-suit-row" key={type}>
            <b>{type}</b>
            {Array.from({ length: 9 }, (_, index) => {
              const value = index + 1
              const count = analysis.knownTileCounts.find(item => item.tile.type === type && item.tile.value === value)?.count ?? 0
              return <span className={count === 4 ? 'exhausted' : ''} key={value}><i>{value}</i><small>{count}</small></span>
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

function SettlementPage({ state, history, onHome, onNewGame }: { state: GameState, history: GameHistoryEntry[], onHome: () => void, onNewGame: () => void }) {
  const [showAllEvents, setShowAllEvents] = useState(false)
  const [reviewFeedback, setReviewFeedback] = useState<'认可' | '不认可' | null>(null)
  const summary = buildSettlementSummary(state)
  const intelligentReview = analyzeGame(state.events, 0)
  const review = buildGameReview(state)
  const insight = buildHistoryInsight(history)
  const timeline = buildEventTimeline(state, showAllEvents)
  const ordered = [...summary.players].sort((a, b) => a.rank - b.rank)
  const transferSection = (title: string, transfers: typeof summary.instantTransfers) => (
    <section className="settlement-card">
      <h3>{title}</h3>
      {transfers.length === 0
        ? <p className="muted">无计分流水</p>
        : (
            <ol className="transfer-list">
              {transfers.map(event => (
                <li key={event.sequence}>
                  <span>
                    #
                    {event.sequence}
                    {' '}
                    {PLAYER_NAMES[event.from]}
                    {' '}
                    →
                    {' '}
                    {PLAYER_NAMES[event.to]}
                  </span>
                  <strong>
                    {event.amount}
                    分 ·
                    {' '}
                    {SCORE_REASON_LABELS[event.reason]}
                  </strong>
                </li>
              ))}
            </ol>
          )}
    </section>
  )
  return (
    <main className="settlement-page">
      <header>
        <span className="eyebrow">牌局结算</span>
        <h1>{summary.endReason}</h1>
        <p>
          Seed
          {state.seed}
          {' '}
          · 本局事件可回放
        </p>
      </header>
      <section className="ranking-grid">
        {ordered.map(player => (
          <article className={`rank-card rank-${player.rank}`} key={player.playerId}>
            <span>
              第
              {player.rank}
              {' '}
              名
            </span>
            <h2>{PLAYER_NAMES[player.playerId]}</h2>
            <strong>
              {player.score >= 0 ? '+' : ''}
              {player.score}
              {' '}
              分
            </strong>
            <p>{player.hasWon ? `已胡 · ${player.winFan}番` : '未胡'}</p>
          </article>
        ))}
      </section>
      <section className="settlement-card">
        <h3>四家战绩</h3>
        <div className="stats-grid">
          {summary.players.map(player => (
            <div key={player.playerId}>
              <b>{PLAYER_NAMES[player.playerId]}</b>
              <span>
                {player.hasWon ? '胡牌 1' : '胡牌 0'}
                {' '}
                · 点炮
                {' '}
                {player.dealtIn}
              </span>
              <span>
                明杠
                {player.kongCounts.mingGang}
                {' '}
                / 补杠
                {player.kongCounts.buGang}
                {' '}
                / 暗杠
                {player.kongCounts.anGang}
              </span>
              <span>
                杠分收入
                {player.kongIncome}
                {' '}
                · 支出
                {player.kongExpense}
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className="settlement-flow">
        {transferSection('对局即时流水', summary.instantTransfers)}
        {transferSection('终局结算', summary.finalTransfers)}
      </div>
      <section className="settlement-card ready-settlement">
        <h3>查叫关系</h3>
        {summary.readyTransfers.length === 0
          ? <p className="muted">本局无查叫赔付</p>
          : (
              <div className="ready-relations">
                {summary.readyTransfers.map(event => (
                  <div key={event.sequence}>
                    <span>
                      {PLAYER_NAMES[event.from]}
                      <small>未听</small>
                    </span>
                    <strong>
                      赔付
                      {event.amount}
                      分
                    </strong>
                    <span>
                      {PLAYER_NAMES[event.to]}
                      <small>听牌方</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
      </section>
      <section className="settlement-card game-review">
        <span className="eyebrow">智能牌局复盘</span>
        <h3>{review.headline}</h3>
        <p className="muted">{review.summary}</p>
        {review.decisions.length === 0
          ? <p>本局没有可分析的用户决策。</p>
          : (
              <div className="review-decisions">
                {review.decisions.map(decision => (
                  <article key={decision.sequence}>
                    <div className="review-heading">
                      <strong>
                        #
                        {decision.sequence}
                        {' '}
                        {decision.title}
                      </strong>
                      <span className={`review-rating rating-${decision.rating}`}>{decision.rating}</span>
                    </div>
                    <div className="review-hand">{decision.hand.map(tile => <MajiangTile tile={tile} key={tile.id} small />)}</div>
                    <p>
                      实际：
                      <b>{decision.actual}</b>
                      {' · '}
                      推荐：
                      <b>{decision.recommended}</b>
                    </p>
                    <small>{decision.reason}</small>
                  </article>
                ))}
              </div>
            )}
      </section>
      <section className="settlement-card intelligent-review">
        <div className="intelligent-review-header">
          <div>
            <span className="eyebrow">M2 智能复盘报告</span>
            <h3>牌效与决策诊断</h3>
          </div>
          <div className="review-feedback" aria-label="复盘报告反馈">
            <span>报告是否有帮助？</span>
            <button className={reviewFeedback === '认可' ? 'feedback-active' : ''} onClick={() => setReviewFeedback('认可')}>认可</button>
            <button className={reviewFeedback === '不认可' ? 'feedback-active feedback-negative' : ''} onClick={() => setReviewFeedback('不认可')}>不认可</button>
          </div>
        </div>
        {intelligentReview.summary.majorIssues.length > 0
          ? (
              <div className="intelligent-review-columns">
                <div>
                  <h4>主要问题</h4>
                  <div className="intelligent-issues">
                    {intelligentReview.summary.majorIssues.map(issue => (
                      <article key={`${issue.sequence}-${issue.title}`} className="intelligent-issue">
                        <strong>{issue.title}</strong>
                        <p>{issue.detail}</p>
                      </article>
                    ))}
                  </div>
                </div>
                <div>
                  <h4>优秀决策</h4>
                  {intelligentReview.summary.goodDecision
                    ? (
                        <article className="intelligent-highlight">
                          <strong>{intelligentReview.summary.goodDecision.title}</strong>
                          <p>{intelligentReview.summary.goodDecision.detail}</p>
                        </article>
                      )
                    : <p className="muted">本局暂未发现达到优秀标准的决策。</p>}
                </div>
              </div>
            )
          : <p className="muted">本局未发现明显问题，继续保持稳定的出牌节奏。</p>}
        <div className="opportunity-trend">
          <div className="trend-heading">
            <h4>转和空间变化</h4>
            <span>{intelligentReview.decisions.filter(decision => decision.evaluable).length} 次可比较出牌</span>
          </div>
          <p className="opportunity-explainer">这张图只看你每次出牌后，桌上还有多少张牌能立刻把手牌推向听牌或和牌。柱子高，说明路更宽；柱子突然变矮，往往意味着把关键搭子或可用叫口打窄了。副露后的暗手结构暂不混进图里，避免把看不准的局面装成精确结论。</p>
          <div className="trend-bars" aria-label="每次出牌后的转和空间变化">
            {intelligentReview.decisions.filter(decision => decision.evaluable).length > 0
              ? intelligentReview.decisions.filter(decision => decision.evaluable).map((decision, index) => <span key={`${decision.sequence}-${decision.opportunityActual}`} className={decision.opportunityLoss >= 4 ? 'trend-loss' : ''} style={{ height: `${Math.max(8, Math.min(100, decision.opportunityActual * 10))}%` }} title={`第${index + 1}次：实战留${decision.opportunityActual}张活张，更宽路线留${decision.opportunityBest}张，少留${decision.opportunityLoss}张`} />)
              : <span className="trend-empty">暂无足够的暗手节点可比较转和空间</span>}
          </div>
        </div>
        <div className="intelligent-stats">
          <div><b>{intelligentReview.stats.decisions}</b><span>分析决策</span></div>
          <div><b>{intelligentReview.stats.totalLoss}</b><span>累计少留活张</span></div>
          <div><b>{intelligentReview.stats.averageLoss.toFixed(1)}</b><span>平均少留活张</span></div>
        </div>
        <div className="decision-lessons">
          <h4>把“可改进”变成下一次能用的动作</h4>
          {intelligentReview.decisions.filter(decision => decision.evaluable && decision.opportunityLoss > 0).sort((a, b) => b.opportunityLoss - a.opportunityLoss).slice(0, 3).map(decision => (
            <article key={decision.sequence}>
              <div><strong>第 {decision.sequence} 手 · 打 {decision.tile.value}{decision.tile.type}</strong><b>把路打窄了 {decision.opportunityLoss} 张活张</b></div>
              <p>你这条路：剩 {decision.opportunityActual} 张活张（{decision.actualWaits.length === 0 ? '未成活叫' : decision.actualWaits.map(wait => `${wait.tile.value}${wait.tile.type}×${wait.remaining}`).join('、')}），后续比较难接。</p>
              <p>更宽的路：打 {decision.bestTiles.slice(0, 2).map(tile => `${tile.value}${tile.type}`).join('、')}，还能留 {decision.opportunityBest} 张活张（{decision.bestWaits.length === 0 ? '未成活叫' : decision.bestWaits.map(wait => `${wait.tile.value}${wait.tile.type}×${wait.remaining}`).join('、')}）。</p>
              <small>{decision.brokenCombos.length > 0 ? `结构提醒：你同时拆了 ${decision.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 这组能接住多种来牌的搭子。` : `当时牌墙还有 ${decision.wallTiles} 张；下次先把各条路的“牌名×剩余张数”摆出来，再选更容易兑现的一边。`}</small>
            </article>
          ))}
          {intelligentReview.decisions.filter(decision => decision.evaluable && decision.opportunityLoss > 0).length === 0 && <p className="muted">本局没有把明显更宽的转和路线打窄；下一阶段可把注意力放在番型价值与攻防取舍。</p>}
        </div>
      </section>
      {insight !== null && insight.gameCount >= 2 && (
        <section className="settlement-card history-insight">
          <span className="eyebrow">
            近
            {insight.gameCount}
            {' '}
            局整体分析
          </span>
          <h3>
            {insight.winCount}
            /
            {insight.gameCount}
            局胡牌 · 决策可改进率
            {Math.round(insight.improvableRate * 100)}
            %
          </h3>
          <section className="player-portrait" aria-label="玩家画像">
            <div className="portrait-heading"><span>玩家画像 · 动态判断</span><strong>{insight.portrait.label}</strong></div>
            <p>{insight.portrait.description}</p>
            <div className="portrait-columns">
              <div><b>你的优势</b>{insight.portrait.strengths.map(item => <span key={item}>{item}</span>)}</div>
              <div><b>下一阶段主线</b>{insight.portrait.focus.map(item => <span key={item}>{item}</span>)}</div>
            </div>
          </section>
          <div className="history-stats">
            <div>
              <b className={insight.totalScore >= 0 ? 'positive-score' : 'negative-score'}>
                {insight.totalScore >= 0 ? '+' : ''}
                {insight.totalScore}
              </b>
              <span>累计得分</span>
            </div>
            <div>
              <b>
                {insight.avgRank.toFixed(1)}
              </b>
              <span>平均排名</span>
            </div>
            <div>
              <b>
                {insight.dealtInCount}
              </b>
              <span>点炮次数</span>
            </div>
            <div>
              <b>
                {insight.decisionCount}
              </b>
              <span>复盘决策数</span>
            </div>
          </div>
          <div className="history-ratings" aria-label="决策评级分布">
            <span className="rating-bar">
              <i className="rating-excellent" style={{ width: `${Math.round(insight.excellentRate * 100)}%` }} />
              <i className="rating-reasonable" style={{ width: `${Math.round((1 - insight.excellentRate - insight.improvableRate) * 100)}%` }} />
              <i className="rating-improvable" style={{ width: `${Math.round(insight.improvableRate * 100)}%` }} />
            </span>
            <div className="rating-legend">
              <span>
                优秀
                {Math.round(insight.excellentRate * 100)}
                %
              </span>
              <span>
                合理
                {Math.round((1 - insight.excellentRate - insight.improvableRate) * 100)}
                %
              </span>
              <span>
                可改进
                {Math.round(insight.improvableRate * 100)}
                %
              </span>
            </div>
          </div>
          {insight.trendDelta !== null && (
            <p className={`history-trend ${insight.trendDelta <= 0 ? 'positive-score' : 'negative-score'}`}>
              {insight.trendDelta <= 0 ? '↓ 趋势向好' : '↑ 波动上升'}
              ：最近一局可改进率
              {Math.round((insight.latestImprovableRate ?? 0) * 100)}
              %，较前几局平均
              {insight.trendDelta <= 0 ? '下降' : '上升'}
              {Math.abs(Math.round(insight.trendDelta * 100))}
              个百分点
            </p>
          )}
          {insight.issueGroups.length > 0 && (
            <div className="history-issues">
              {insight.issueGroups.slice(0, 3).map(group => (
                <div className="history-issue" key={group.label}>
                  <strong>
                    {group.label}
                    ×
                    {group.count}
                  </strong>
                  {group.latest && (
                    <small>
                      最近一例：实际
                      {group.latest.actual}
                      ，推荐
                      {group.latest.recommended}
                      ——
                      {group.latest.reason}
                    </small>
                  )}
                </div>
              ))}
            </div>
          )}
          {insight.advice.length > 0 && (
            <ul className="history-advice">
              {insight.advice.map(item => <li key={item}>{item}</li>)}
            </ul>
          )}
        </section>
      )}
      <section className="settlement-card event-replay">
        <div className="event-replay-heading">
          <div>
            <h3>本局事件回放</h3>
            <p className="muted">按事件序号回顾本局关键动作与计分变化</p>
          </div>
          <button className="secondary-action compact" onClick={() => setShowAllEvents(current => !current)}>
            {showAllEvents ? '只看关键事件' : `查看全部 ${state.events.length} 条`}
          </button>
        </div>
        <ol className="event-timeline">
          {timeline.map(item => (
            <li key={item.sequence}>
              <span className="event-sequence">
                #
                {item.sequence}
              </span>
              <span>{item.message}</span>
            </li>
          ))}
        </ol>
      </section>
      <div className="settlement-actions">
        <button className="primary-action" onClick={onNewGame}>再来一局</button>
        <button className="secondary-action" onClick={onHome}>返回首页</button>
      </div>
    </main>
  )
}

export function SichuanGame({ seed, restoredState, timedTraining, trainingKind, onHome, onNewGame }: SichuanGameProps) {
  const [state, setState] = useState(() => restoredState ?? (trainingKind === undefined ? createInitialGame(seed) : createSpecialTrainingGame(seed, trainingKind)))
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [thinking, setThinking] = useState<PlayerId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [assistantEnabled, setAssistantEnabled] = useState(false)
  const stateRef = useRef(state)
  const scheduleToken = useRef(0)
  const pausedRef = useRef(false)
  const historyRef = useRef<GameHistoryEntry[] | null>(null)
  stateRef.current = state
  pausedRef.current = paused

  const legal = useMemo(() => getLegalActions(state, 0), [state])
  const discardActions = legal.filter((action): action is Extract<LegalAction, { type: 'discard' }> => action.type === 'discard')
  const discardIds = new Set(discardActions.map(action => action.tileId))
  const otherActions = legal.filter((action): action is Exclude<LegalAction, { type: 'discard' | 'dingque' }> => action.type !== 'discard' && action.type !== 'dingque')
  const recommended = recommendDingque(state.players[0].hand)

  const submit = (action: LegalAction) => {
    if (pausedRef.current)
      return
    const current = stateRef.current
    const stillLegal = getLegalActions(current, 0).some(candidate => JSON.stringify(candidate) === JSON.stringify(action))
    if (!stillLegal)
      return
    const result = executeCommand(current, { ...action, playerId: 0 })
    if (!result.ok) {
      setError(result.error)
      return
    }
    scheduleToken.current++
    setError(null)
    setSelectedTileId(null)
    stateRef.current = result.nextState
    setState(result.nextState)
    saveUnfinishedGame(result.nextState, { timedTraining })
  }

  useEffect(() => {
    saveUnfinishedGame(state, { timedTraining })
  }, [])

  useEffect(() => {
    const handleVisibility = () => {
      const hidden = document.visibilityState !== 'visible'
      if (hidden) {
        scheduleToken.current++
        saveUnfinishedGame(stateRef.current, { timedTraining })
      }
      setPaused(hidden)
      if (!hidden)
        setRemainingSeconds(null)
    }
    const handlePageLeave = () => {
      scheduleToken.current++
      saveUnfinishedGame(stateRef.current, { timedTraining })
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', handlePageLeave)
    window.addEventListener('beforeunload', handlePageLeave)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', handlePageLeave)
      window.removeEventListener('beforeunload', handlePageLeave)
    }
  }, [])

  const togglePaused = () => {
    setPaused((current) => {
      const next = !current
      pausedRef.current = next
      scheduleToken.current++
      if (next) {
        saveUnfinishedGame(stateRef.current, { timedTraining })
        setRemainingSeconds(null)
      }
      return next
    })
  }

  useEffect(() => {
    const duration = getTurnTimerDuration(state, timedTraining)
    if (duration === null) {
      setRemainingSeconds(null)
      return
    }
    setRemainingSeconds(duration)
    const startedAt = Date.now()
    const timeout = window.setInterval(() => {
      if (pausedRef.current)
        return
      const remaining = Math.max(0, duration - Math.floor((Date.now() - startedAt) / 1000))
      setRemainingSeconds(remaining)
      if (remaining === 0) {
        window.clearInterval(timeout)
        const current = stateRef.current
        const action = getTimeoutCommand(current, 0)
        if (action !== null && !pausedRef.current) {
          const result = executeCommand(current, action)
          if (result.ok) {
            stateRef.current = result.nextState
            setState(result.nextState)
            saveUnfinishedGame(result.nextState, { timedTraining })
          }
        }
      }
    }, 250)
    return () => window.clearInterval(timeout)
  }, [paused, state, timedTraining])

  useEffect(() => {
    if (paused || !shouldAdvanceAI(state))
      return

    const preview = advanceAIOnce(state)
    if (preview.command === null || preview.command.playerId === 0)
      return
    const token = ++scheduleToken.current
    setThinking(preview.command.playerId)
    const timeout = window.setTimeout(() => {
      if (token !== scheduleToken.current || stateRef.current !== state)
        return
      if (!shouldAdvanceAI(stateRef.current))
        return
      const advanced = advanceAIOnce(stateRef.current)
      if (advanced.command === null || advanced.command.playerId === 0)
        return
      stateRef.current = advanced.state
      setState(advanced.state)
      saveUnfinishedGame(advanced.state, { timedTraining })
      setThinking(null)
      setSelectedTileId(null)
    }, 350 + Math.abs(state.nextEventSequence * 73 + seed) % 301)
    return () => {
      window.clearTimeout(timeout)
      if (token === scheduleToken.current)
        setThinking(null)
    }
  }, [paused, seed, state])

  if (state.phase === 'finished') {
    if (historyRef.current === null) {
      const entry = buildTheoryHistoryEntry(state, analyzeGame(state.events, 0))
      recordFinishedGame(entry)
      historyRef.current = [entry, ...loadGameHistory()]
    }
    clearUnfinishedGame()
    return <SettlementPage state={state} history={historyRef.current} onHome={onHome} onNewGame={onNewGame} />
  }

  const leaveGame = () => {
    saveUnfinishedGame(stateRef.current, { timedTraining })
    onHome()
  }

  const abandonGame = () => {
    if (window.confirm('放弃当前牌局？本局不会计入统计。')) { // eslint-disable-line no-alert
      scheduleToken.current++
      clearUnfinishedGame()
      onHome()
    }
  }

  return (
    <main className="game-shell">
      <header className="game-topbar">
        <div>
          <span className="eyebrow">成都血战到底</span>
          <strong>
            {trainingKind === undefined ? '四人实战' : SPECIAL_TRAINING_META[trainingKind].title} · Seed
            {seed}
          </strong>
        </div>
        <div>
          <label className="assistant-toggle">
            <input
              type="checkbox"
              checked={assistantEnabled}
              onChange={event => setAssistantEnabled(event.target.checked)}
            />
            <span>出牌助手</span>
          </label>
          {paused && <span className="turn-timer">已暂停</span>}
          {timedTraining && !paused && remainingSeconds !== null && (
            <span className={`turn-timer ${remainingSeconds < 5 ? 'warning' : ''}`}>
              {state.phase === 'discarding' ? '出牌' : '响应'}
              剩余
              {remainingSeconds}
              秒
            </span>
          )}
          <button className="secondary-action compact" onClick={togglePaused}>{paused ? '继续' : '暂停'}</button>
          <button className="secondary-action compact" onClick={leaveGame}>返回首页</button>
          <button className="secondary-action compact" onClick={abandonGame}>放弃牌局</button>
        </div>
      </header>
      <StrategicReminderPanel state={state} />
      {assistantEnabled && <AssistantPanel state={state} selectedTileId={selectedTileId} />}
      <div className="table-grid">
        {[1, 2, 3].map(id => <PlayerPanel key={id} state={state} playerId={id as PlayerId} thinking={thinking} />)}
        <section className="table-center">
          <div className="wall-count">
            <span>牌墙</span>
            <strong>{state.wall.length}</strong>
            <small>张</small>
          </div>
          <p>{state.phase === 'dingque' ? '定缺阶段' : state.phase === 'responding' ? '响应阶段' : `${PLAYER_NAMES[state.currentPlayer]}行动`}</p>
          <div className="latest-event">{formatGameEvent(state.events[state.events.length - 1])}</div>
        </section>
        <SouthPlayerPanel
          state={state}
          thinking={thinking}
          selectedTileId={selectedTileId}
          setSelectedTileId={setSelectedTileId}
          discardActions={discardActions}
          discardIds={discardIds}
          otherActions={otherActions}
          legal={legal}
          submit={submit}
        />
      </div>

      {(error || (state.phase === 'dingque' && state.players[0].dingque === null)) && (
        <section className="user-control-panel">
          {error && (
            <div className="game-error" role="alert">
              操作失败：
              {error}
            </div>
          )}
          {state.phase === 'dingque' && state.players[0].dingque === null
            ? (
                <div className="dingque-selection">
                  <div className="dingque-hand">
                    <span>你的起手牌</span>
                    <div className="hand-scroll" aria-label="定缺前的你的手牌">{state.players[0].hand.map(tile => <MajiangTile tile={tile} key={tile.id} />)}</div>
                  </div>
                  <div className="dingque-panel">
                    <div>
                      <h2>请选择定缺</h2>
                      <p>先查看起手牌再选择；确认前其他玩家不会开始定缺。</p>
                    </div>
                    <div className="dingque-actions">
                      {legal.filter((action): action is Extract<LegalAction, { type: 'dingque' }> => action.type === 'dingque').map(action => (
                        <button className={action.tileType === recommended ? 'recommended' : ''} key={action.tileType} onClick={() => submit(action)}>
                          {action.tileType}
                          {action.tileType === recommended && <small>推荐</small>}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            : null}
        </section>
      )}
    </main>
  )
}
