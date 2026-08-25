import type { GameHistoryEntry } from '../game/persistence'
import type { GameState, LegalAction, PlayerId, TileInstance } from '../game/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { advanceAIOnce } from '../game/ai'
import { createInitialGame, recommendDingque } from '../game/core'
import { executeCommand, getLegalActions, getTimeoutCommand } from '../game/engine'
import { clearUnfinishedGame, loadGameHistory, recordFinishedGame, saveUnfinishedGame } from '../game/persistence'
import { AI_STYLE_LABELS, buildEventTimeline, buildGameReview, buildHistoryEntry, buildHistoryInsight, buildSettlementSummary, formatGameEvent, MELD_LABELS, PLAYER_NAMES, SCORE_REASON_LABELS } from '../game/presentation'
import { shouldAdvanceAI } from '../game/ui'
import { analyzeGame } from '../review/analyzer'
import { MajiangTile } from './MajiangTile'

interface SichuanGameProps {
  seed: number
  restoredState?: GameState
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

function SouthPlayerPanel({ state, thinking, selectedTileId, setSelectedTileId, discardActions, discardIds, otherActions, legal, submit }: { state: GameState, thinking: PlayerId | null, selectedTileId: string | null, setSelectedTileId: (id: string | null) => void, discardActions: Extract<LegalAction, { type: 'discard' }>[], discardIds: Set<string>, otherActions: Exclude<LegalAction, { type: 'discard' | 'dingque' }>[], legal: LegalAction[], submit: (action: LegalAction) => void }) {
  const player = state.players[0]
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
            <h4>机会数趋势</h4>
            <span>
              {intelligentReview.stats.opportunityTrend.length}
              {' 次可分析出牌'}
            </span>
          </div>
          <div className="trend-bars" aria-label="每次出牌后的机会数趋势">
            {intelligentReview.stats.opportunityTrend.length > 0
              ? intelligentReview.stats.opportunityTrend.map((value, index) => <span key={`${index}-${value}`} style={{ height: `${Math.max(8, Math.min(100, value * 10))}%` }} title={`第${index + 1}次：${value}个机会`} />)
              : <span className="trend-empty">暂无足够数据</span>}
          </div>
        </div>
        <div className="intelligent-stats">
          <div>
            <b>{intelligentReview.stats.decisions}</b>
            <span>分析决策</span>
          </div>
          <div>
            <b>{intelligentReview.stats.totalLoss}</b>
            <span>机会数总损失</span>
          </div>
          <div>
            <b>{intelligentReview.stats.averageLoss.toFixed(1)}</b>
            <span>平均损失</span>
          </div>
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

export function SichuanGame({ seed, restoredState, onHome, onNewGame }: SichuanGameProps) {
  const [state, setState] = useState(() => restoredState ?? createInitialGame(seed))
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [thinking, setThinking] = useState<PlayerId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
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
    saveUnfinishedGame(result.nextState)
  }

  useEffect(() => {
    saveUnfinishedGame(state)
  }, [])

  useEffect(() => {
    const handleVisibility = () => {
      const hidden = document.visibilityState !== 'visible'
      if (hidden) {
        scheduleToken.current++
        saveUnfinishedGame(stateRef.current)
      }
      setPaused(hidden)
      if (!hidden)
        setRemainingSeconds(null)
    }
    const handlePageLeave = () => {
      scheduleToken.current++
      saveUnfinishedGame(stateRef.current)
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
        saveUnfinishedGame(stateRef.current)
        setRemainingSeconds(null)
      }
      return next
    })
  }

  useEffect(() => {
    if (!((state.phase === 'discarding' && state.currentPlayer === 0) || (state.phase === 'responding' && state.responseWindow?.eligiblePlayers.includes(0) && state.responseWindow.choices[0] === undefined))) {
      setRemainingSeconds(null)
      return
    }
    setRemainingSeconds(state.phase === 'discarding' ? 15 : 8)
    const startedAt = Date.now()
    const duration = state.phase === 'discarding' ? 15 : 8
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
            saveUnfinishedGame(result.nextState)
          }
        }
      }
    }, 250)
    return () => window.clearInterval(timeout)
  }, [paused, state])

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
      saveUnfinishedGame(advanced.state)
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
      const entry = buildHistoryEntry(state, buildGameReview(state))
      recordFinishedGame(entry)
      historyRef.current = [entry, ...loadGameHistory()]
    }
    clearUnfinishedGame()
    return <SettlementPage state={state} history={historyRef.current} onHome={onHome} onNewGame={onNewGame} />
  }

  const leaveGame = () => {
    saveUnfinishedGame(stateRef.current)
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
            四人实战 · Seed
            {seed}
          </strong>
        </div>
        <div>
          {paused && <span className="turn-timer">已暂停</span>}
          {!paused && remainingSeconds !== null && (
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
          <div className="all-rivers">
            {state.players.map(player => (
              <div key={player.id}>
                <b>{PLAYER_NAMES[player.id]}</b>
                {player.discards.slice(-8).map(tile => <MiniTile key={tile.id} tile={tile} />)}
              </div>
            ))}
          </div>
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
