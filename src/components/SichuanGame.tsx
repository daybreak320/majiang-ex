import type { GameHistoryEntry } from '../game/persistence'
import type { GameState, LegalAction, OpponentConfig, PlayerId, TileInstance } from '../game/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { advanceAIOnce } from '../game/ai'
import type { DiscardCandidateAnalysis } from '../game/assistant'
import { buildCandidateLesson, buildDiscardAssistant, buildHuLesson, buildPengLesson } from '../game/assistant'
import { createInitialGame, createSpecialTrainingGame, getWideBedScenario, getWideTenpaiScenario, recommendDingque, SPECIAL_TRAINING_META } from '../game/core'
import type { SpecialTrainingKind } from '../game/core'
import { executeCommand, getLegalActions, getTimeoutCommand } from '../game/engine'
import { clearUnfinishedGame, loadGameHistory, recordFinishedGame, saveUnfinishedGame } from '../game/persistence'
import { buildEventTimeline, buildGameReview, buildHistoryInsight, buildSettlementSummary, buildTheoryHistoryEntry, formatGameEvent, MELD_LABELS, PLAYER_NAMES, recommendTraining, SCORE_REASON_LABELS } from '../game/presentation'
import { buildStrategicReminder, detectOpponentThreats, inferEndgameDefense } from '../game/strategy'
import { getTurnTimerDuration, shouldAdvanceAI } from '../game/ui'
import { analyzeGame } from '../review/analyzer'
import { goldenLineLabel } from '../knowledge/mahjongTheory'
import { MajiangTile } from './MajiangTile'

interface SichuanGameProps {
  seed: number
  restoredState?: GameState
  timedTraining: boolean
  opponentConfigs?: readonly OpponentConfig[]
  trainingKind?: SpecialTrainingKind
  onHome: () => void
  onNewGame: () => void
  onStartTraining: (kind: SpecialTrainingKind) => void
}

const PLAYER_POSITIONS = ['south', 'west', 'north', 'east'] as const

function tileLabel(tile: Pick<TileInstance, 'type' | 'value'>): string {
  return `${tile.value}${tile.type}`
}

function MiniTile({ tile }: { tile: TileInstance }) {
  return <MajiangTile tile={tile} small />
}

function playerName(state: GameState, playerId: PlayerId): string {
  return state.players[playerId].displayName?.trim() || PLAYER_NAMES[playerId]
}

function PlayerPanel({ state, playerId, thinking }: { state: GameState, playerId: PlayerId, thinking: PlayerId | null }) {
  const player = state.players[playerId]
  const name = playerName(state, playerId)
  return (
    <section className={`player-panel player-${PLAYER_POSITIONS[playerId]} ${state.currentPlayer === playerId && state.phase === 'discarding' ? 'active-player' : ''}`}>
      <div className="player-heading">
        <div>
          <strong>{name}</strong>
          {playerId === state.dealer && <span className="dealer-badge">庄</span>}
        </div>
        <strong className={player.score >= 0 ? 'positive-score' : 'negative-score'}>
          {player.score >= 0 ? '+' : ''}
          {player.score}
        </strong>
      </div>
      <div className="player-meta">
        <span className="dingque-status">
          定缺
          <b>{player.dingque ?? '—'}</b>
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
      <small>金线检查：当前弃牌落在{goldenLineLabel(candidate.tile)}；比较选听时，把同门 1-4-7 / 2-5-8 / 3-6-9 的连接一起核对，别只数单张活张。</small>
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

function EndgameDefensePanel({ state }: { state: GameState }) {
  const inference = useMemo(() => inferEndgameDefense(state), [state])
  if (!inference.active)
    return null
  return (
    <aside className="endgame-defense-panel" aria-label="尾盘公开信息猜牌">
      <header className="endgame-defense-heading">
        <div>
          <span className="eyebrow">尾盘防守 · 公开信息猜牌</span>
          <h3>牌墙剩 {inference.wallTiles} 张：按“不能花猪、要争取听牌”推演</h3>
        </div>
        <p>{inference.premise}</p>
      </header>
      <div className="endgame-opponents">
        {inference.opponents.map(opponent => (
          <article key={opponent.playerId}>
            <header><strong>{opponent.position}</strong><span>{opponent.dingque === null ? '未定缺' : `定缺${opponent.dingque}${opponent.clearedDingque ? ' · 已清' : ' · 未清'}`}</span></header>
            {opponent.possibilities.map(item => <p key={item.kind}><b className={`inference-${item.confidence}`}>{item.confidence === 'high' ? '高可能' : item.confidence === 'medium' ? '中可能' : '低可能'}</b>{item.label}：{item.reason}</p>)}
            <small>{opponent.dangerTypes.length > 0 ? `危险门：${opponent.dangerTypes.join('、')}。` : `优先安全门：${opponent.safeTypes.length > 0 ? opponent.safeTypes.join('、') : '先找现物与熟张'}。`}{opponent.caveat}</small>
          </article>
        ))}
      </div>
    </aside>
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

function SettlementPage({ state, history, onHome, onNewGame, onStartTraining }: { state: GameState, history: GameHistoryEntry[], onHome: () => void, onNewGame: () => void, onStartTraining: (kind: SpecialTrainingKind) => void }) {
  const [showAllEvents, setShowAllEvents] = useState(false)
  const [reviewFeedback, setReviewFeedback] = useState<'认可' | '不认可' | null>(null)
  const [selectedRouteSequence, setSelectedRouteSequence] = useState<number | null>(null)
  const summary = buildSettlementSummary(state)
  const intelligentReview = analyzeGame(state.events, 0)
  const review = buildGameReview(state)
  const insight = buildHistoryInsight(history)
  const trainingRecommendation = recommendTraining(history)
  const timeline = buildEventTimeline(state, showAllEvents)
  const comparableDecisions = intelligentReview.decisions.filter(decision => decision.evaluable)
  const routeMistakes = comparableDecisions.filter(decision => decision.opportunityLoss > 0).sort((a, b) => b.opportunityLoss - a.opportunityLoss)
  const routeHighlights = comparableDecisions.filter(decision => decision.opportunityLoss === 0 && decision.opportunityActual >= 8).sort((a, b) => b.opportunityActual - a.opportunityActual)
  // 复盘结论必须落在真实事件流里：有失误先看失误；无失误则挑出保住路线的代表手。
  const keyRouteDecisions = routeMistakes.length > 0
    ? routeMistakes.slice(0, 3)
    : (routeHighlights.length > 0 ? routeHighlights.slice(0, 2) : comparableDecisions.slice(0, 2))
  const keyRouteDecisionMap = new Map(keyRouteDecisions.map(decision => [decision.sequence, decision]))
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
      </section>
      <section className="settlement-card review-workbench">
        <aside className="route-verdict">
          <div className="route-verdict-heading">
            <div>
              <span className="eyebrow">这局的转和结论</span>
              <h3>{routeMistakes.length === 0 ? '牌效路线守住了' : `有 ${routeMistakes.length} 手把路线走窄`}</h3>
            </div>
            <span>{comparableDecisions.length} 次可比出牌</span>
          </div>
          <p className="route-verdict-good">{routeMistakes.length === 0
            ? '不是只报“守住了”。下面列出最有代表性的保路手，点选后在右侧直接看它前后发生的公开事件。'
            : '先看最影响后续的转折手。点选一手，右侧会把对应出牌和局势过程高亮出来。'}</p>
          <div className="route-node-list" aria-label="关键路线节点">
            {keyRouteDecisions.length === 0
              ? <p className="muted">本局没有足够的暗手节点可作牌效比较。</p>
              : keyRouteDecisions.map((decision, index) => {
                  const isMistake = decision.opportunityLoss > 0
                  const selected = selectedRouteSequence === decision.sequence
                  return (
                    <button key={decision.sequence} className={`route-node-button ${isMistake ? 'route-node-mistake' : 'route-node-good'} ${selected ? 'route-node-selected' : ''}`} onClick={() => setSelectedRouteSequence(selected ? null : decision.sequence)}>
                      <span>{isMistake ? `转折 ${index + 1}` : `保路 ${index + 1}`}</span>
                      <strong>{`#${decision.sequence} · 打 ${tileLabel(decision.tile)}`}</strong>
                      <small>{isMistake ? `少留 ${decision.opportunityLoss} 张有效进张` : `保留 ${decision.opportunityActual} 张有效进张`}</small>
                    </button>
                  )
                })}
          </div>
          <p className="route-verdict-footnote">这里只检查弃牌是否走窄进张路；做大牌与攻防取舍仍要结合对手副露、牌墙和安全性判断。</p>
        </aside>
        <div className="workbench-replay event-replay">
          <div className="event-replay-heading">
            <div>
              <span className="eyebrow">证据回放</span>
              <h3>本局事件过程</h3>
              <p className="muted">关键节点会嵌在真实事件之间，不脱离前后局势。</p>
            </div>
            <button className="secondary-action compact" onClick={() => setShowAllEvents(current => !current)}>
              {showAllEvents ? '只看关键事件' : `查看全部 ${state.events.length} 条`}
            </button>
          </div>
          <ol className="event-timeline">
            {timeline.map(item => {
              const routeDecision = keyRouteDecisionMap.get(item.sequence)
              const isMistake = routeDecision !== undefined && routeDecision.opportunityLoss > 0
              const isSelected = routeDecision !== undefined && selectedRouteSequence === item.sequence
              return (
                <li key={item.sequence} className={`${routeDecision === undefined ? '' : `event-route-node ${isMistake ? 'event-route-mistake' : 'event-route-good'}`} ${isSelected ? 'event-route-selected' : ''}`}>
                  <span className="event-sequence">#{item.sequence}</span>
                  <div className="event-timeline-copy">
                    <span>{item.message}</span>
                    {routeDecision !== undefined && (
                      <article className="event-route-explainer">
                        <strong>{isMistake ? '路线转折：这手把进张路走窄了' : '路线守住：这手保住了当时更宽的进张路'}</strong>
                        <p>{isMistake
                          ? `你打 ${tileLabel(routeDecision.tile)} 后，只剩 ${routeDecision.opportunityActual} 张有效进张；改打 ${routeDecision.bestTiles.slice(0, 2).map(tileLabel).join('、')} 可留 ${routeDecision.opportunityBest} 张。`
                          : `你打 ${tileLabel(routeDecision.tile)} 后，仍留 ${routeDecision.opportunityActual} 张有效进张（${routeDecision.actualWaits.slice(0, 4).map(wait => `${tileLabel(wait.tile)}×${wait.remaining}`).join('、') || '后续仍有多种补强'}）。`}</p>
                        <small>{isMistake && routeDecision.brokenCombos.length > 0 ? `当时拆开了 ${routeDecision.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 连搭；` : ''}{`牌墙剩 ${routeDecision.wallTiles} 张。`}</small>
                      </article>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
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
      {trainingRecommendation !== null && (
        <section className="settlement-card training-recommendation">
          <span className="eyebrow">下一局针对练</span>
          <h3>{trainingRecommendation.title}</h3>
          <p>{trainingRecommendation.reason}</p>
          <small>{trainingRecommendation.evidence}</small>
          <button className="primary-action" onClick={() => onStartTraining(trainingRecommendation.kind)}>
            进入「{SPECIAL_TRAINING_META[trainingRecommendation.kind].title}」
          </button>
        </section>
      )}
      <div className="settlement-actions">
        <button className="primary-action" onClick={onNewGame}>再来一局</button>
        <button className="secondary-action" onClick={onHome}>返回首页</button>
      </div>
    </main>
  )
}

export function SichuanGame({ seed, restoredState, timedTraining, opponentConfigs, trainingKind, onHome, onNewGame, onStartTraining }: SichuanGameProps) {
  const [state, setState] = useState(() => restoredState ?? (trainingKind === undefined ? createInitialGame(seed, opponentConfigs) : createSpecialTrainingGame(seed, trainingKind)))
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [thinking, setThinking] = useState<PlayerId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [assistantEnabled, setAssistantEnabled] = useState(false)
  const [skipToResult, setSkipToResult] = useState(false)
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
  const wideBedScenario = trainingKind === 'attack-qingyise' ? getWideBedScenario(seed) : null
  const wideTenpaiTraining = trainingKind === 'endgame-qingyise-tenpai' ? getWideTenpaiScenario(seed) : null
  const jingoudiaoTraining = trainingKind === 'attack-jingoudiao'
  const playerHasLeftTable = state.players[0].hasWon

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

    if (skipToResult) {
      let next = stateRef.current
      let steps = 0
      while (shouldAdvanceAI(next) && steps < 5000) {
        const advanced = advanceAIOnce(next)
        if (advanced.command === null || advanced.command.playerId === 0)
          break
        next = advanced.state
        steps++
      }
      if (next !== stateRef.current) {
        scheduleToken.current++
        stateRef.current = next
        setState(next)
        saveUnfinishedGame(next, { timedTraining })
      }
      return
    }

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
  }, [paused, seed, skipToResult, state])

  if (state.phase === 'finished') {
    if (historyRef.current === null) {
      const entry = buildTheoryHistoryEntry(state, analyzeGame(state.events, 0))
      recordFinishedGame(entry)
      historyRef.current = [entry, ...loadGameHistory()]
    }
    clearUnfinishedGame()
    return <SettlementPage state={state} history={historyRef.current} onHome={onHome} onNewGame={onNewGame} onStartTraining={onStartTraining} />
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
          {playerHasLeftTable
            ? (skipToResult
                ? <span className="turn-timer">正在直接结算…</span>
                : <button className="primary-action compact" onClick={() => setSkipToResult(true)}>不看过程，直接出结果</button>)
            : <button className="secondary-action compact" onClick={abandonGame}>放弃牌局</button>}
          <button className="secondary-action compact" onClick={leaveGame}>返回首页</button>
        </div>
      </header>
      {wideTenpaiTraining !== null && (
        <section className="strategic-reminder wide-bed-briefing qingyise-tenpai-briefing">
          <div>
            <span className="eyebrow">下宽叫残局 · {wideTenpaiTraining.kind === 'qingyise' ? '清一色' : '杠开'}</span>
            <h3>{wideTenpaiTraining.title}</h3>
            <p>{wideTenpaiTraining.goal} 请用出牌助手比较：打后有几种叫口、实际还活几张，以及哪条路在最后十张里更容易兑现。</p>
          </div>
          <div className="strategic-reminder-signals">
            <span>牌墙：10 张</span>
            <span>公开河牌已扣张</span>
            <span>先看活张，再看叫口种类</span>
            <span>点选候选牌看导师逐手解释</span>
          </div>
        </section>
      )}
      {jingoudiaoTraining && (
        <section className="strategic-reminder wide-bed-briefing qingyise-tenpai-briefing">
          <div>
            <span className="eyebrow">金钩钓残局 · 每巡换听</span>
            <h3>四副碰牌已完成，只留一张单吊</h3>
            <p>你每次摸进两张候选后都要二选一：留下哪张单吊，桌上真正还活的牌更多？打开出牌助手，导师会按当前扣张逐手说明推荐与换听代价。</p>
          </div>
          <div className="strategic-reminder-signals">
            <span>四副碰牌已公开</span>
            <span>只比较二选一单吊</span>
            <span>每次摸牌重新扣张</span>
            <span>直到胡牌为止</span>
          </div>
        </section>
      )}
      {wideBedScenario !== null && (
        <section className="strategic-reminder wide-bed-briefing">
          <div>
            <span className="eyebrow">宽床开局 · 第一步别急着押宝</span>
            <h3>{wideBedScenario.title}</h3>
            <p>{wideBedScenario.condition}</p>
          </div>
          <div className="strategic-reminder-signals">
            <span>本局变量：手牌结构 / 上牌质量 / 对手推进速度</span>
            <span>你的任务：先判断是否值得为大牌牺牲速度，再随摸牌和公开动作复核。</span>
            <span>可选路线：清一色 / 七对自摸 / 普通自摸 / 素胡走人</span>
            <span>{wideBedScenario.teachingGoal}</span>
          </div>
        </section>
      )}
      <StrategicReminderPanel state={state} />
      {(() => {
        const endgameActive = state.wall.length <= 16 && state.phase !== 'dingque'
        return (
          <div className={`game-columns ${endgameActive ? 'endgame-active' : ''}`}>
            {endgameActive && (
              <div className="game-column game-left">
                <EndgameDefensePanel state={state} />
              </div>
            )}
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
            <div className="game-column game-right">
              {assistantEnabled && <AssistantPanel state={state} selectedTileId={selectedTileId} />}
            </div>
          </div>
        )
      })()}

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
