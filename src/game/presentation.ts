import type { GameHistoryEntry, ReviewIssueSample } from './persistence'
import type { GameCommand, GameEvent, GameState, MeldKind, PlayerId, ScoreReason, TileInstance } from './types'
import { chooseAICommand, getAIReason } from './ai'
import { createInitialGame } from './core'

export const PLAYER_NAMES = ['你', '青锋', '沉舟', '逐浪'] as const

export const AI_STYLE_LABELS = {
  aggressive: '进攻型',
  steady: '稳健型',
  efficient: '效率型',
} as const

export const SCORE_REASON_LABELS: Record<ScoreReason, string> = {
  self_draw: '自摸',
  discard_win: '点炮胡',
  kong: '杠分',
  call_transfer: '呼叫转移',
  kong_refund: '退税',
  flower_pig: '花猪赔付',
  ready_compensation: '查叫赔付',
}

export const MELD_LABELS: Record<MeldKind, string> = {
  peng: '碰',
  mingGang: '明杠',
  buGang: '补杠',
  anGang: '暗杠',
}

const RESPONSE_LABELS = {
  hu: '胡',
  peng: '碰',
  gang: '杠',
  pass: '过',
} as const

const RESPONSE_OUTCOME_LABELS = {
  none: '无人鸣牌，继续摸牌',
  peng: '碰牌成立',
  gang: '杠牌成立',
  hu: '胡牌成立',
  robbedKong: '抢杠胡成立',
} as const

const TIMELINE_EVENT_TYPES = new Set<GameEvent['type']>([
  'dingque_selected',
  'tile_discarded',
  'meld_declared',
  'player_won',
  'score_transferred',
  'final_settlement_started',
  'final_settlement_completed',
  'game_finished',
])

export interface EventTimelineItem {
  sequence: number
  message: string
  type: GameEvent['type']
}

function tileLabel(tile: { type: string, value: number }): string {
  return `${tile.value}${tile.type}`
}

export function formatGameEvent(event: GameEvent | undefined): string {
  if (event === undefined)
    return '牌局已就绪，请先完成定缺'
  switch (event.type) {
    case 'dingque_selected': return `${PLAYER_NAMES[event.playerId]}定缺${event.tileType}`
    case 'tile_drawn': return `${PLAYER_NAMES[event.playerId]}摸牌${event.replacement ? '（杠后补张）' : ''}`
    case 'tile_discarded': return `${PLAYER_NAMES[event.playerId]}打出 ${tileLabel(event.tile)}`
    case 'response_opened': return `等待对 ${tileLabel(event.window.tile)} 的响应`
    case 'response_chosen': return `${PLAYER_NAMES[event.playerId]}选择${RESPONSE_LABELS[event.choice.type]}`
    case 'response_settled': return RESPONSE_OUTCOME_LABELS[event.outcome]
    case 'meld_declared': return `${PLAYER_NAMES[event.playerId]}${MELD_LABELS[event.meld.kind]} ${tileLabel(event.meld.tiles[0])}`
    case 'player_won': return `${PLAYER_NAMES[event.playerId]}胡牌，${event.info.fan}番`
    case 'score_transferred': return `${PLAYER_NAMES[event.from]} → ${PLAYER_NAMES[event.to]} ${event.amount}分（${SCORE_REASON_LABELS[event.reason]}）`
    case 'turn_changed': return `轮到${PLAYER_NAMES[event.playerId]}行动`
    case 'final_settlement_started': return '开始终局结算'
    case 'final_settlement_completed': return '终局结算完成'
    case 'game_finished': return event.reason === 'three_winners' ? '三家已胡，本局结束' : '牌墙耗尽，本局结束'
    case 'passed_win_set': return event.value === null ? `${PLAYER_NAMES[event.playerId]}过手胡限制解除` : `${PLAYER_NAMES[event.playerId]}选择过胡`
  }
}

export function buildEventTimeline(state: GameState, includeAll = false): EventTimelineItem[] {
  return state.events
    .filter(event => includeAll || TIMELINE_EVENT_TYPES.has(event.type))
    .map(event => ({ sequence: event.sequence, message: formatGameEvent(event), type: event.type }))
}

export type ReviewRating = '优秀' | '合理' | '可改进'

export interface DecisionReview {
  sequence: number
  title: string
  rating: ReviewRating
  hand: TileInstance[]
  actual: string
  recommended: string
  reason: string
}

export interface GameReview {
  headline: string
  summary: string
  decisions: DecisionReview[]
}

function actionLabel(command: GameCommand, state: GameState): string {
  switch (command.type) {
    case 'dingque': return `定缺${command.tileType}`
    case 'discard': {
      const tile = state.players[command.playerId].hand.find(candidate => candidate.id === command.tileId)
      return tile === undefined ? '出牌' : `打出${tileLabel(tile)}`
    }
    case 'hu': return '胡牌'
    case 'peng': return '碰牌'
    case 'gang': return MELD_LABELS[command.kind]
    case 'pass': return '过'
  }
}

function sameAction(actual: GameCommand, recommended: GameCommand): boolean {
  if (actual.type !== recommended.type)
    return false
  if (actual.type === 'dingque' && recommended.type === 'dingque')
    return actual.tileType === recommended.tileType
  if (actual.type === 'discard' && recommended.type === 'discard')
    return actual.tileId === recommended.tileId
  if (actual.type === 'gang' && recommended.type === 'gang')
    return actual.tileId === recommended.tileId && actual.kind === recommended.kind
  return true
}

function userCommand(events: readonly GameEvent[]): { command: GameCommand, sequence: number } | null {
  const dingque = events.find((event): event is Extract<GameEvent, { type: 'dingque_selected' }> => event.type === 'dingque_selected' && event.playerId === 0)
  if (dingque)
    return { command: { type: 'dingque', playerId: 0, tileType: dingque.tileType }, sequence: dingque.sequence }
  const response = events.find((event): event is Extract<GameEvent, { type: 'response_chosen' }> => event.type === 'response_chosen' && event.playerId === 0)
  if (response) {
    const tileId = events.find(event => event.type === 'response_opened')?.window.tile.id ?? ''
    const command: GameCommand = response.choice.type === 'hu'
      ? { ...response.choice, playerId: 0, tileId }
      : response.choice.type === 'pass'
        ? { type: 'pass', playerId: 0 }
        : response.choice.type === 'gang'
          ? { type: 'gang', playerId: 0, tileId, kind: 'mingGang' }
          : { type: 'peng', playerId: 0, tileId }
    return { command, sequence: response.sequence }
  }
  const discard = events.find((event): event is Extract<GameEvent, { type: 'tile_discarded' }> => event.type === 'tile_discarded' && event.playerId === 0)
  if (discard)
    return { command: { type: 'discard', playerId: 0, tileId: discard.tile.id }, sequence: discard.sequence }
  const win = events.find((event): event is Extract<GameEvent, { type: 'player_won' }> => event.type === 'player_won' && event.playerId === 0)
  if (win)
    return { command: { type: 'hu', playerId: 0, tileId: win.info.tile.id, value: win.info.points }, sequence: win.sequence }
  const meld = events.find((event): event is Extract<GameEvent, { type: 'meld_declared' }> => event.type === 'meld_declared' && event.playerId === 0)
  if (meld) {
    if (meld.meld.kind === 'peng')
      return { command: { type: 'peng', playerId: 0, tileId: meld.meld.tiles[0].id }, sequence: meld.sequence }
    return { command: { type: 'gang', playerId: 0, tileId: meld.meld.tiles[0].id, kind: meld.meld.kind }, sequence: meld.sequence }
  }
  return null
}

export function buildGameReview(finalState: GameState): GameReview {
  let before = createInitialGame(finalState.seed)
  let groupStart = 0
  const reviews: DecisionReview[] = []

  for (let index = 0; index < finalState.events.length; index++) {
    const checkpoint = finalState.events[index]
    if (checkpoint.state === undefined)
      continue
    const group = finalState.events.slice(groupStart, index + 1)
    const actual = userCommand(group)
    if (actual !== null) {
      const recommended = chooseAICommand(before, 0)
      if (recommended !== null) {
        const matches = sameAction(actual.command, recommended)
        const isForced = actual.command.type === 'discard'
          && before.players[0].hand.filter(tile => tile.type === before.players[0].dingque).length === 1
        reviews.push({
          sequence: actual.sequence,
          title: actual.command.type === 'dingque' ? '定缺选择' : actual.command.type === 'discard' ? '出牌决策' : '响应决策',
          rating: matches ? '优秀' : isForced ? '合理' : '可改进',
          hand: structuredClone(before.players[0].hand),
          actual: actionLabel(actual.command, before),
          recommended: actionLabel(recommended, before),
          reason: matches
            ? getAIReason(before, 0, recommended)
            : `推荐${actionLabel(recommended, before)}。${getAIReason(before, 0, recommended)}`,
        })
      }
    }
    before = {
      ...structuredClone(checkpoint.state),
      events: structuredClone(finalState.events.slice(0, index + 1)),
      nextEventSequence: checkpoint.sequence + 1,
    }
    groupStart = index + 1
  }

  const selected = reviews
    .filter(review => review.rating === '可改进' || review.title === '定缺选择')
    .slice(0, 8)
  const fallback = selected.length === 0 ? reviews.slice(0, 3) : selected
  const improvements = reviews.filter(review => review.rating === '可改进').length
  return {
    headline: improvements === 0 ? '整体决策稳健' : `发现 ${improvements} 个可改进决策`,
    summary: improvements === 0
      ? '你的关键选择与当前牌效策略一致。'
      : '建议优先关注定缺结构、出牌后的有效连接以及鸣牌收益。',
    decisions: fallback,
  }
}

export interface PlayerSettlementSummary {
  playerId: PlayerId
  score: number
  rank: number
  hasWon: boolean
  winFan: number | null
  winKind: 'selfDraw' | 'discard' | 'robKong' | null
  dealtIn: number
  kongCounts: Record<'mingGang' | 'buGang' | 'anGang', number>
  kongIncome: number
  kongExpense: number
}

export interface SettlementSummary {
  endReason: string
  players: PlayerSettlementSummary[]
  instantTransfers: Extract<GameEvent, { type: 'score_transferred' }>[]
  finalTransfers: Extract<GameEvent, { type: 'score_transferred' }>[]
  readyTransfers: Extract<GameEvent, { type: 'score_transferred' }>[]
}

export function buildSettlementSummary(state: GameState): SettlementSummary {
  const settlementStart = state.events.find(event => event.type === 'final_settlement_started')?.sequence ?? Number.POSITIVE_INFINITY
  const transfers = state.events.filter((event): event is Extract<GameEvent, { type: 'score_transferred' }> => event.type === 'score_transferred')
  const ordered = [...state.players].sort((a, b) => b.score - a.score || a.id - b.id)

  return {
    endReason: state.endReason === 'three_winners' ? '三家已胡，血战结束' : '牌墙已摸完，进入终局结算',
    players: state.players.map((player) => {
      const kongTransfers = transfers.filter(event => event.reason === 'kong')
      return {
        playerId: player.id,
        score: player.score,
        rank: ordered.findIndex(candidate => candidate.id === player.id) + 1,
        hasWon: player.hasWon,
        winFan: player.winInfo?.fan ?? null,
        winKind: player.winInfo?.kind ?? null,
        dealtIn: state.events.filter(event => event.type === 'player_won' && event.info.fromPlayer === player.id).length,
        kongCounts: {
          mingGang: player.melds.filter(meld => meld.kind === 'mingGang').length,
          buGang: player.melds.filter(meld => meld.kind === 'buGang').length,
          anGang: player.melds.filter(meld => meld.kind === 'anGang').length,
        },
        kongIncome: kongTransfers.filter(event => event.to === player.id).reduce((sum, event) => sum + event.amount, 0),
        kongExpense: kongTransfers.filter(event => event.from === player.id).reduce((sum, event) => sum + event.amount, 0),
      }
    }),
    instantTransfers: transfers.filter(event => event.sequence < settlementStart),
    finalTransfers: transfers.filter(event => event.sequence > settlementStart),
    readyTransfers: transfers.filter(event => event.sequence > settlementStart && event.reason === 'ready_compensation'),
  }
}

export function buildHistoryEntry(state: GameState, review: GameReview): GameHistoryEntry {
  const summary = buildSettlementSummary(state)
  const self = summary.players.find(player => player.playerId === 0)
  const issues: ReviewIssueSample[] = review.decisions
    .filter(decision => decision.rating === '可改进')
    .slice(0, 4)
    .map(decision => ({
      title: decision.title,
      actual: decision.actual,
      recommended: decision.recommended,
      reason: decision.reason,
    }))
  const allRatings = review.decisions.map(decision => decision.rating)
  return {
    finishedAt: Date.now(),
    seed: state.seed,
    endReason: summary.endReason,
    score: self?.score ?? 0,
    rank: self?.rank ?? 0,
    hasWon: self?.hasWon ?? false,
    winFan: self?.winFan ?? null,
    dealtIn: self?.dealtIn ?? 0,
    decisionsExcellent: allRatings.filter(rating => rating === '优秀').length,
    decisionsReasonable: allRatings.filter(rating => rating === '合理').length,
    decisionsImprovable: allRatings.filter(rating => rating === '可改进').length,
    issues,
  }
}

export interface HistoryIssueGroup {
  label: string
  count: number
  latest: ReviewIssueSample | null
}

export interface HistoryInsight {
  gameCount: number
  totalScore: number
  avgRank: number
  winCount: number
  dealtInCount: number
  decisionCount: number
  excellentRate: number
  improvableRate: number
  latestImprovableRate: number | null
  trendDelta: number | null
  issueGroups: HistoryIssueGroup[]
  advice: string[]
}

function improvableRateOf(entry: GameHistoryEntry): number | null {
  const total = entry.decisionsExcellent + entry.decisionsReasonable + entry.decisionsImprovable
  return total === 0 ? null : entry.decisionsImprovable / total
}

const ISSUE_ADVICE: Record<string, string> = {
  定缺选择: '定缺前先数三门牌张数与搭子结构，缺门最少、搭子最少的一门优先缺；结算页的推荐定缺可直接对照学习。',
  出牌决策: '出牌前先数机会数：留下两面听搭子，优先打孤张与无辐射的浮牌；2、7 万这类边张能辐射更多进张，轻易别拆。',
  响应决策: '碰杠不是多多益善：碰牌会锁死手牌灵活度，先想清楚碰完之后听什么、机会数还剩多少再动手。',
}

export function buildHistoryInsight(entries: readonly GameHistoryEntry[]): HistoryInsight | null {
  if (entries.length === 0)
    return null
  const scope = entries.slice(0, 3)
  const decisionCount = scope.reduce((sum, entry) => sum + entry.decisionsExcellent + entry.decisionsReasonable + entry.decisionsImprovable, 0)
  const improvable = scope.reduce((sum, entry) => sum + entry.decisionsImprovable, 0)
  const excellent = scope.reduce((sum, entry) => sum + entry.decisionsExcellent, 0)
  const latestRate = improvableRateOf(scope[0])
  const earlierEntries = scope.slice(1).map(improvableRateOf).filter((rate): rate is number => rate !== null)
  const earlierAvg = earlierEntries.length === 0 ? null : earlierEntries.reduce((sum, rate) => sum + rate, 0) / earlierEntries.length

  const grouped = new Map<string, { count: number, latest: ReviewIssueSample | null }>()
  for (const entry of scope) {
    for (const issue of entry.issues) {
      const current = grouped.get(issue.title) ?? { count: 0, latest: null }
      grouped.set(issue.title, { count: current.count + 1, latest: issue })
    }
  }
  const issueGroups: HistoryIssueGroup[] = [...grouped.entries()]
    .map(([label, value]) => ({ label, count: value.count, latest: value.latest }))
    .sort((a, b) => b.count - a.count)

  const advice: string[] = []
  for (const group of issueGroups.slice(0, 2))
    advice.push(`${group.label}（近${scope.length}局出现 ${group.count} 次）：${ISSUE_ADVICE[group.label] ?? '对照本局复盘中的推荐打法练习同类决策。'}`)
  if (latestRate !== null && earlierAvg !== null) {
    if (latestRate < earlierAvg - 0.05)
      advice.push(`趋势向好：最近一局可改进决策占比 ${Math.round(latestRate * 100)}%，比前几局平均下降了 ${Math.round((earlierAvg - latestRate) * 100)} 个百分点，保持这个节奏。`)
    else if (latestRate > earlierAvg + 0.05)
      advice.push(`注意波动：最近一局可改进决策占比 ${Math.round(latestRate * 100)}%，比前几局平均高出 ${Math.round((latestRate - earlierAvg) * 100)} 个百分点，建议放慢出牌节奏。`)
  }
  if (scope.reduce((sum, entry) => sum + entry.dealtIn, 0) >= 2)
    advice.push('近期点炮偏多：尾盘跟住同线牌（1-4-7 / 2-5-8 / 3-6-9），对手打过的线更安全。')

  return {
    gameCount: scope.length,
    totalScore: scope.reduce((sum, entry) => sum + entry.score, 0),
    avgRank: scope.reduce((sum, entry) => sum + entry.rank, 0) / scope.length,
    winCount: scope.filter(entry => entry.hasWon).length,
    dealtInCount: scope.reduce((sum, entry) => sum + entry.dealtIn, 0),
    decisionCount,
    excellentRate: decisionCount === 0 ? 0 : excellent / decisionCount,
    improvableRate: decisionCount === 0 ? 0 : improvable / decisionCount,
    latestImprovableRate: latestRate,
    trendDelta: latestRate !== null && earlierAvg !== null ? latestRate - earlierAvg : null,
    issueGroups,
    advice,
  }
}
