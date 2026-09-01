import type { ReviewReport } from '../review/types'
import type { GameHistoryEntry, ReviewIssueSample } from './persistence'
import type { GameCommand, GameEvent, GameState, MeldKind, PlayerId, ScoreReason, TileInstance } from './types'
import { REVIEW_ALGORITHM_VERSION } from '../review/analyzer'
import { chooseAICommand, getAIReason } from './ai'
import { createInitialGame } from './core'
import type { SpecialTrainingKind } from './core'

export const PLAYER_NAMES = ['你', '做大做强', '搞死搞残', '先跑为敬'] as const

export const AI_STYLE_LABELS = {
  aggressive: '进攻型 · 爱冲',
  steady: '稳健型 · 看河',
  efficient: '效率型 · 牌效党',
  qingyise: '清一色狂热爱好者',
  turtle: '极度保守 · 常年逃跑',
  pengManiac: '自摸杠开狂热爱好者',
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

export interface TableMood {
  stage: '开局塑形' | '中盘比速' | '尾盘决战'
  threat: '平稳' | '警觉' | '危险'
  message: string
}

export function buildTableMood(state: GameState): TableMood {
  const exposedOpponents = state.players.slice(1).filter(player => player.melds.length > 0 && !player.hasWon)
  const nearEndgame = state.wall.length <= 16
  if (nearEndgame)
    return { stage: '尾盘决战', threat: exposedOpponents.length > 0 ? '危险' : '警觉', message: exposedOpponents.length > 0 ? '牌墙见底且有人副露：先守住安全退路。' : '牌墙见底：每张牌都要兼顾听牌与安全。' }
  if (exposedOpponents.length >= 2)
    return { stage: '中盘比速', threat: '危险', message: '两家以上副露：速度已经拉满，别把危险牌送出去。' }
  if (exposedOpponents.length === 1)
    return { stage: '中盘比速', threat: '警觉', message: '有人副露推进：比较牌效时，把安全退路一起算。' }
  if (state.wall.length <= 45)
    return { stage: '中盘比速', threat: '平稳', message: '牌效开始分胜负：优先看有效进张与下叫速度。' }
  return { stage: '开局塑形', threat: '平稳', message: '先清缺、理搭子，别急着为大牌牺牲速度。' }
}

export function formatAIBehaviorTag(state: GameState, event: GameEvent | undefined): string | null {
  if (event === undefined || !('playerId' in event) || event.playerId === 0)
    return null
  const player = state.players[event.playerId]
  const name = player.displayName?.trim() || PLAYER_NAMES[event.playerId]
  const style = player.aiStyle
  if (event.type === 'meld_declared') {
    if (event.meld.kind === 'peng')
      return `【${name}】鸣牌提速，公开推进。`
    if (event.meld.kind === 'mingGang' || event.meld.kind === 'buGang')
      return `【${name}】${event.meld.kind === 'mingGang' ? '明杠' : '补杠'}后补张，局势加速。`
    return `【${name}】暗杠蓄力，牌面仍有悬念。`
  }
  if (event.type === 'response_chosen' && event.choice.type === 'pass')
    return `【${name}】选择不过度鸣牌，保留手牌弹性。`
  if (event.type === 'tile_discarded') {
    if (style === 'aggressive') return `【${name}】继续施压，牌路偏向进攻。`
    if (style === 'efficient') return `【${name}】两面与速度优先，抢先下叫。`
    if (style === 'steady') return `【${name}】稳住牌效，也在看公开牌河。`
    if (style === 'qingyise') return `【${name}】同门执念未退，仍在为做大牌铺路。`
    if (style === 'turtle') return `【${name}】局势收紧，优先给自己留退路。`
    if (style === 'pengManiac') return `【${name}】保留杠后路线，等能加速的机会。`
  }
  return null
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

export interface SpecialTrainingReview {
  objective: string
  outcome: string
  keyPoint: string
  nextPractice: string
}

/** 专项结算不只给胜负：把整局中的实际决策压缩成下一次可执行的训练结论。 */
export function buildSpecialTrainingReview(state: GameState, kind: SpecialTrainingKind, report: ReviewReport): SpecialTrainingReview {
  const self = state.players[0]
  const mistakes = report.decisions
    .filter(decision => decision.evaluable && decision.opportunityLoss > 0)
    .sort((a, b) => b.opportunityLoss - a.opportunityLoss)
  const best = mistakes[0]
  const won = self.hasWon
  const outcome = won
    ? `本题已胡牌${self.winInfo === null ? '' : ` · ${self.winInfo.fan}番`}。`
    : state.endReason === 'wall_empty'
      ? '牌墙已尽，本题以终局结算结束。'
      : '本题结束，回看关键决策而不只看最终输赢。'

  if (kind === 'endgame-count') {
    return {
      objective: '最后十张：按公开河牌扣张，同时比较活张、叫口与安全退路。',
      outcome,
      keyPoint: best === undefined
        ? '本题没有出现明显的牌效走窄；尾盘仍应逐张核对公开扣张，别把“看起来能听”当成活叫。'
        : `关键转折在 #${best.sequence}：实际打 ${tileLabel(best.tile)} 后只留 ${best.opportunityActual} 张有效进张；改打 ${best.bestTiles.slice(0, 2).map(tileLabel).join('、')} 可留 ${best.opportunityBest} 张。`,
      nextPractice: best === undefined
        ? '下一题先报出：哪几张已死、哪几张还活，再决定是否追听。'
        : `下一题先列出 ${best.actualWaits.slice(0, 4).map(wait => `${tileLabel(wait.tile)}×${wait.remaining}`).join('、') || '实际活张'}，再和最优方案的 ${best.bestWaits.slice(0, 4).map(wait => `${tileLabel(wait.tile)}×${wait.remaining}`).join('、') || '活张'} 对比。`,
    }
  }

  const objectives: Record<Exclude<SpecialTrainingKind, 'endgame-count'>, string> = {
    'attack-qingyise': '宽床决策：在清一色收益、普通自摸速度与转和退路之间取舍。',
    'attack-jingoudiao': '金钩钓换听：四副碰牌后，按真实余张选择更活的单吊。',
    'defense-big-hands': '三家做大：识别公开副露后降速，不给对手喂关键牌。',
    'defense-race-qingyise': '同门竞速：比较自己速度与对手公开推进，决定抢跑或转防。',
    'endgame-qingyise-tenpai': '下宽叫：同样能下叫时，优先选择真正活张更多的听口。',
  }
  return {
    objective: objectives[kind],
    outcome,
    keyPoint: best === undefined
      ? '本题没有检测到明显的有效进张损失；继续把公开牌河和对手副露纳入判断。'
      : `关键转折在 #${best.sequence}：打 ${tileLabel(best.tile)} 少留 ${best.opportunityLoss} 张有效进张；推荐 ${best.bestTiles.slice(0, 2).map(tileLabel).join('、')}。`,
    nextPractice: best === undefined ? '下一题继续先看牌河，再决定速度与安全的优先级。' : `下一题遇到类似结构，先比较“打后活张”而不是只看手牌是否整齐。`,
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

/** 将朱扬理论复盘报告投影为近三局统计所需的历史摘要。 */
export function buildTheoryHistoryEntry(state: GameState, report: ReviewReport): GameHistoryEntry {
  const summary = buildSettlementSummary(state)
  const self = summary.players.find(player => player.playerId === 0)
  const issueBySequence = new Map(report.decisions.map(decision => [decision.sequence, decision]))
  const issues: ReviewIssueSample[] = report.summary.majorIssues.map((issue) => {
    const decision = issueBySequence.get(issue.sequence)
    return {
      kind: issue.kind,
      title: issue.title,
      actual: decision === undefined ? '出牌' : `打出${decision.tile.value}${decision.tile.type}`,
      recommended: decision === undefined || decision.bestTiles.length === 0
        ? '理论建议'
        : decision.bestTiles.slice(0, 2).map(tile => `打出${tile.value}${tile.type}`).join('、'),
      reason: issue.detail,
      opportunityLoss: decision?.opportunityLoss,
    }
  })
  const improvable = report.issues.length
  const excellent = report.highlights.length
  const reasonable = Math.max(0, report.stats.decisions - improvable - excellent)
  return {
    finishedAt: Date.now(),
    seed: state.seed,
    endReason: summary.endReason,
    score: self?.score ?? 0,
    rank: self?.rank ?? 0,
    hasWon: self?.hasWon ?? false,
    winFan: self?.winFan ?? null,
    dealtIn: self?.dealtIn ?? 0,
    decisionsExcellent: excellent,
    decisionsReasonable: reasonable,
    decisionsImprovable: improvable,
    issues,
    learning: {
      evaluableDecisions: report.decisions.filter(decision => decision.evaluable).length,
      totalOpportunityLoss: report.stats.totalLoss,
      maxOpportunityLoss: Math.max(0, ...report.decisions.map(decision => decision.opportunityLoss)),
      lateDangerDiscards: report.issues.filter(issue => issue.kind === 'attackDefense').length,
      strongComboBreaks: report.issues.filter(issue => issue.kind === 'strongCombo').length,
      meldCount: state.players[0].melds.length,
      averageOpportunity: report.decisions.filter(decision => decision.evaluable).length === 0
        ? 0
        : report.decisions.filter(decision => decision.evaluable).reduce((sum, decision) => sum + decision.opportunityActual, 0) / report.decisions.filter(decision => decision.evaluable).length,
    },
    reviewAlgorithmVersion: REVIEW_ALGORITHM_VERSION,
  }
}

export interface HistoryIssueGroup {
  label: string
  count: number
  latest: ReviewIssueSample | null
}

export interface PlayerPortrait {
  label: string
  description: string
  strengths: string[]
  focus: string[]
}

export interface TrainingRecommendation {
  kind: SpecialTrainingKind
  title: string
  reason: string
  evidence: string
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
  portrait: PlayerPortrait
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
  tileEfficiency: '牌效训练：每次出牌先数活张，再看哪张牌保留的两面搭与复合搭子更多。',
  attackDefense: '攻防训练：牌墙后段先找熟张与安全线；牌效只领先一点时，不值得用危险牌交换。',
  strongCombo: '结构训练：2-7、3-7、2-8、3-8是高辐射组合，除非能换来更大的活张优势，否则先保护它。',
  meld: '鸣牌训练：碰杠前先问一句——副露后还剩几种叫口、能否更快下叫、暴露风险是否值得。',
}

/** 把复盘中最需要改正的决策，落到可直接进入的专项局面。 */
export function recommendTraining(entries: readonly GameHistoryEntry[]): TrainingRecommendation | null {
  if (entries.length === 0)
    return null
  const scope = entries.slice(0, 8)
  const counts = scope.reduce((total, entry) => {
    total.tileEfficiency += entry.issues.filter(issue => issue.kind === 'tileEfficiency').length
    total.strongCombo += entry.issues.filter(issue => issue.kind === 'strongCombo').length
    total.attackDefense += entry.issues.filter(issue => issue.kind === 'attackDefense').length
    total.meld += entry.issues.filter(issue => issue.kind === 'meld').length
    total.dealtIn += entry.dealtIn
    return total
  }, { tileEfficiency: 0, strongCombo: 0, attackDefense: 0, meld: 0, dealtIn: 0 })

  const top = (Object.entries(counts) as Array<[keyof typeof counts, number]>).sort((a, b) => b[1] - a[1])[0]
  if (top === undefined || top[1] === 0)
    return {
      kind: 'attack-qingyise',
      title: '巩固速度与价值取舍',
      reason: '最近没有重复出现的高优先级问题，先用清一色专项练“保留做大胚子”和“及时下叫”的平衡。',
      evidence: `已参考近 ${scope.length} 局复盘`,
    }

  const [kind, count] = top
  if (kind === 'attackDefense' || kind === 'dealtIn') {
    return {
      kind: 'defense-big-hands',
      title: '先补防守止损',
      reason: '你的复盘里尾盘危险牌或点炮信号最突出。先练在三家做大时找现物、缩小危险门，而不是硬追一两张进张。',
      evidence: `近 ${scope.length} 局：攻防问题 ${counts.attackDefense} 次，点炮 ${counts.dealtIn} 次`,
    }
  }
  if (kind === 'meld') {
    return {
      kind: 'attack-jingoudiao',
      title: '先补鸣牌与杠的取舍',
      reason: '鸣牌决策反复出现问题。用金钩钓与杠开专项练“碰/杠后能否更快下叫”和“为杠付出的风险”。',
      evidence: `近 ${scope.length} 局：鸣牌问题 ${count} 次`,
    }
  }
  if (kind === 'strongCombo') {
    return {
      kind: 'attack-qingyise',
      title: '先补强组合保护',
      reason: '你较常把能同时接住多种来牌的搭子拆开。先在单门集中局练保搭、保宽叫，再决定是否为了清一色提速。',
      evidence: `近 ${scope.length} 局：强组合问题 ${count} 次`,
    }
  }
  return {
    kind: 'endgame-count',
    title: '先补活张与残局算牌',
    reason: '当前最常见的是把更宽的转和路线打窄。残局会把公开牌河和十张牌墙固定下来，强迫你逐张核对还剩什么。',
    evidence: `近 ${scope.length} 局：转和路线问题 ${count} 次`,
  }
}

function buildPlayerPortrait(entries: readonly GameHistoryEntry[], issueGroups: HistoryIssueGroup[], decisionCount: number, totalLoss: number, dangerCount: number, comboBreaks: number): PlayerPortrait {
  const lossPerDecision = decisionCount === 0 ? 0 : totalLoss / decisionCount
  const strengths: string[] = []
  const focus: string[] = []
  if (lossPerDecision <= 1.5 && decisionCount >= 4)
    strengths.push('牌效基本盘稳定，机会数损失控制得住。')
  if (entries.filter(entry => entry.dealtIn === 0).length >= Math.ceil(entries.length / 2))
    strengths.push('防守纪律不错，近期多数牌局没有点炮。')
  if (strengths.length === 0)
    strengths.push('已经在积累可复盘样本，先用每局的机会数差做校准。')
  if (lossPerDecision > 3)
    focus.push('先把出牌节奏放慢：每手先比较活张差，目标是把平均机会数损失压到 2 张以内。')
  if (comboBreaks > 0)
    focus.push('优先练强组合保护：遇到 2-7、3-7、2-8、3-8，先确认是否真能换来更大活张。')
  if (dangerCount > 0)
    focus.push('尾盘先保命：对手副露后，熟张与安全线优先级要高过一两张机会数。')
  if (focus.length === 0)
    focus.push('当前先练“机会数 + 价值”双看：活张接近时，优先保留基础番更高、叫口更宽的路线。')
  const top = issueGroups[0]?.label
  const label = lossPerDecision > 3 ? '进攻型试错者' : dangerCount > 0 ? '牌效优先型' : '稳健效率型'
  return {
    label,
    description: `基于近 ${entries.length} 局、${decisionCount} 个决策样本${top ? `，最常见课题是“${top}”` : ''}。这是动态训练画像，不是给你贴死标签。`,
    strengths,
    focus,
  }
}

export function buildHistoryInsight(entries: readonly GameHistoryEntry[]): HistoryInsight | null {
  if (entries.length === 0)
    return null
  // 近三局反映近期状态；画像扩大到最多 8 局，避免一两局给玩家贴标签。
  const scope = entries.slice(0, 8)
  const decisionCount = scope.reduce((sum, entry) => sum + entry.decisionsExcellent + entry.decisionsReasonable + entry.decisionsImprovable, 0)
  const improvable = scope.reduce((sum, entry) => sum + entry.decisionsImprovable, 0)
  const excellent = scope.reduce((sum, entry) => sum + entry.decisionsExcellent, 0)
  const latestRate = improvableRateOf(scope[0])
  const earlierEntries = scope.slice(1).map(improvableRateOf).filter((rate): rate is number => rate !== null)
  const earlierAvg = earlierEntries.length === 0 ? null : earlierEntries.reduce((sum, rate) => sum + rate, 0) / earlierEntries.length

  const grouped = new Map<string, { count: number, latest: ReviewIssueSample | null }>()
  for (const entry of scope) {
    for (const issue of entry.issues) {
      const key = issue.kind ?? issue.title
      const current = grouped.get(key) ?? { count: 0, latest: null }
      grouped.set(key, { count: current.count + 1, latest: issue })
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

  const totalLoss = scope.reduce((sum, entry) => sum + (entry.learning?.totalOpportunityLoss ?? 0), 0)
  const dangerCount = scope.reduce((sum, entry) => sum + (entry.learning?.lateDangerDiscards ?? 0), 0)
  const comboBreaks = scope.reduce((sum, entry) => sum + (entry.learning?.strongComboBreaks ?? 0), 0)
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
    portrait: buildPlayerPortrait(scope, issueGroups, decisionCount, totalLoss, dangerCount, comboBreaks),
    advice,
  }
}
