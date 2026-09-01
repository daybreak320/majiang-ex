import type { Tile } from '../types'
import type { GameCommand, GameState, LegalAction, PlayerId, TileInstance } from './types'
import { brokenStrongCombos, countOpportunities, goldenLineLabel, rateOpportunity } from '../knowledge/mahjongTheory'
import { chooseAICommand, getAIReason } from './ai'
import { MILESTONE_1_RULES } from './rules'
import { calculateScore } from './scoring'
import { getLegalActions } from './engine'
import { getLegalDiscards } from './core'
import { buildStrategicReminder, detectOpponentThreats } from './strategy'
import type { StrategicReminder } from './strategy'

export interface AssistantWait {
  tile: Tile
  remaining: number
  probability: number
  baseFan: number
  points: number
  patterns: string[]
}

export interface TenpaiPath {
  tile: Tile
  remaining: number
  probability: number
}

export interface PatternTrend {
  pattern: 'qingyise' | 'duiduihu' | 'konghua'
  direction: 'keep' | 'break'
  strength: 'weak' | 'forming' | 'strong'
  summary: string
}

function patternLabel(pattern: PatternTrend['pattern']): string {
  return pattern === 'qingyise' ? '清一色' : pattern === 'duiduihu' ? '对对胡' : '杠上花'
}

function trendAdjustmentLabel(candidate: DiscardCandidateAnalysis): string {
  if (candidate.trendAdjustment > 0)
    return `做牌趋势小幅加权 +${candidate.trendAdjustment.toFixed(3)}（不覆盖活张）`
  if (candidate.trendAdjustment < 0)
    return `做牌/危险门校正 ${candidate.trendAdjustment.toFixed(3)}（速度优先）`
  return '做牌趋势未改变本方案的基础牌效'
}

export interface DiscardCandidateAnalysis {
  tile: Tile
  opportunity: number
  structuralWaits: number
  /** 已经听牌时，下一摸直接和牌的条件概率。未听牌则为 null。 */
  nextDrawWinProbability: number | null
  /** 未听牌时，下一摸后可通过一次正常弃牌进入听牌的条件概率。 */
  nextDrawTenpaiProbability: number | null
  tenpaiPaths: TenpaiPath[]
  /** 当前仍可摸到的活叫。 */
  waits: AssistantWait[]
  /** 牌型上全部可胡的叫口，含公开信息已打光的理论死听。 */
  theoreticalWaits: AssistantWait[]
  averageFan: number | null
  averagePoints: number | null
  /** 做牌趋势仅作小幅、可解释的同档次取舍，绝不替代活张与下叫速度。 */
  trendAdjustment: number
  valueIndex: number
  patternTrends: PatternTrend[]
  brokenCombos: ReadonlyArray<readonly [number, number]>
  isRecommended: boolean
}

export interface KnownTileCount {
  tile: Tile
  count: number
}

export interface CoachMessage {
  /** 当前牌局的行动优先级；来自公开牌河、副露、定缺、牌墙与自己的可兑现路线。 */
  objective: 'defend' | 'race' | 'press' | 'convert'
  mode: 'warning' | 'decision' | 'observe'
  headline: string
  guidance: string
  evidence: string[]
  practice: string
}

/** 用户点选某张牌时给出的逐手讲解；只比较已计算的候选数据与公开攻防信息。 */
export interface CandidateLesson {
  verdict: 'recommended' | 'playable' | 'inferior'
  headline: string
  explanation: string
  evidence: string[]
  nextQuestion: string
}

export interface PengCandidateAnalysis {
  action: Extract<LegalAction, { type: 'peng' }>
  tile: Tile
  beforeOpportunity: number
  afterBestDiscardOpportunity: number
  bestDiscard: Tile | null
  forcedDiscardCount: number
  meldGain: number
  isRecommended: boolean
}

export interface PengLesson {
  verdict: 'recommended' | 'playable' | 'inferior'
  headline: string
  explanation: string
  evidence: string[]
  nextQuestion: string
}

/** 有胡可胡时，比较立即兑现与放弃本次胡牌继续追价值。后者只展示可核验的机会与规则代价，不伪造完整胜率。 */
export interface HuDecisionAnalysis {
  action: Extract<LegalAction, { type: 'hu' }>
  points: number
  fan: number
  wallTiles: number
  continueOpportunity: number
  continueWaits: AssistantWait[]
  mustBeatPassedValue: boolean
  recommendation: 'hu' | 'continue'
}

export interface HuLesson {
  verdict: 'recommended' | 'playable' | 'inferior'
  headline: string
  explanation: string
  evidence: string[]
  nextQuestion: string
}

export interface DiscardAssistantAnalysis {
  recommendation: GameCommand | null
  recommendationLabel: string
  reason: string
  theoryBasis: string[]
  knownTiles: number
  unknownTiles: number
  wallTiles: number
  knownTileCounts: KnownTileCount[]
  opportunity: number
  structuralWaits: number
  nextDrawWinProbability: number | null
  waits: AssistantWait[]
  candidates: DiscardCandidateAnalysis[]
  pengCandidate: PengCandidateAnalysis | null
  huDecision: HuDecisionAnalysis | null
  coach: CoachMessage
}

/** 玩家落子后的一句即时复盘：仅比较该回合候选与公开副露，不读取未来事件或对手暗牌。 */
export interface ImmediateDiscardFeedback {
  kind: 'route' | 'risk' | 'value'
  message: string
}

const OPPORTUNITY_RATING_LABEL: Record<ReturnType<typeof rateOpportunity>, string> = {
  poor: '较少',
  fair: '一般',
  good: '良好',
  excellent: '充足',
}

function sameTile(a: Tile, b: Tile): boolean {
  return a.type === b.type && a.value === b.value
}

function publicTiles(state: GameState): TileInstance[] {
  return state.players.flatMap(player => [
    ...player.discards,
    ...player.melds.flatMap(meld => meld.tiles),
    ...(player.hasWon ? player.hand : []),
  ])
}

function knownTiles(state: GameState, playerId: PlayerId): TileInstance[] {
  const unique = new Map<string, TileInstance>()
  for (const tile of [...state.players[playerId].hand, ...publicTiles(state)])
    unique.set(tile.id, tile)
  return [...unique.values()]
}

function commandLabel(command: GameCommand | null, state: GameState): string {
  if (command === null)
    return '等待行动'
  if (command.type === 'dingque')
    return `定缺${command.tileType}`
  if (command.type === 'discard') {
    const tile = state.players[command.playerId].hand.find(candidate => candidate.id === command.tileId)
    return tile === undefined ? '出牌' : `打 ${tile.value}${tile.type}`
  }
  if (command.type === 'hu')
    return state.phase === 'responding' ? '胡牌' : '自摸胡'
  if (command.type === 'peng')
    return '碰'
  if (command.type === 'gang')
    return command.kind === 'anGang' ? '暗杠' : command.kind === 'buGang' ? '补杠' : '明杠'
  return '过'
}

function tileCounts(tiles: readonly TileInstance[]): KnownTileCount[] {
  return MILESTONE_1_RULES.tileTypes.flatMap(type => MILESTONE_1_RULES.values.map(value => ({
    tile: { type, value },
    count: tiles.filter(candidate => candidate.type === type && candidate.value === value).length,
  })))
}

function waitAnalysis(hand: TileInstance[], visible: TileInstance[], state: GameState, playerId: PlayerId, unknownTiles: number): { opportunity: number, structuralWaits: number, waits: AssistantWait[] } {
  const player = state.players[playerId]
  const opportunity = countOpportunities(hand, visible, { dingque: player.dingque, melds: player.melds })
  const waits = opportunity.structuralWaits.map((wait) => {
    const score = calculateScore([...hand, wait.tile], { melds: player.melds, dingque: player.dingque })
    return {
      ...wait,
      probability: unknownTiles === 0 ? 0 : wait.remaining / unknownTiles,
      baseFan: score?.baseFan ?? 0,
      points: score?.points ?? MILESTONE_1_RULES.baseScore,
      patterns: score?.patterns.map(pattern => pattern.id) ?? [],
    }
  })
  return { opportunity: opportunity.total, structuralWaits: opportunity.structuralWaits.length, waits }
}

function availableDraws(hand: readonly TileInstance[], visible: readonly TileInstance[]): TenpaiPath[] {
  return MILESTONE_1_RULES.tileTypes.flatMap(type => MILESTONE_1_RULES.values.flatMap((value) => {
    const seen = hand.filter(tile => tile.type === type && tile.value === value).length
      + visible.filter(tile => tile.type === type && tile.value === value).length
    const remaining = Math.max(0, MILESTONE_1_RULES.copiesPerTile - seen)
    return remaining === 0 ? [] : [{ tile: { type, value }, remaining, probability: 0 }]
  }))
}

/**
 * 对未听牌的 13 张暗手枚举下一摸：摸入后允许正常弃一张；若能留下任一听牌结构，
 * 则这张进张计作“下一摸入听”。这不是完整多巡 EV，而是可复核的一巡转听概率。
 */
function tenpaiPathAnalysis(hand: TileInstance[], visible: TileInstance[], state: GameState, playerId: PlayerId, unknownTiles: number): TenpaiPath[] {
  const player = state.players[playerId]
  return availableDraws(hand, visible).flatMap((draw) => {
    const virtualDraw: TileInstance = { id: `assistant-${draw.tile.value}-${draw.tile.type}`, ...draw.tile }
    const afterDraw = [...hand, virtualDraw]
    const entersTenpai = afterDraw.some((discard) => {
      const afterDiscard = afterDraw.filter(tile => tile.id !== discard.id)
      return countOpportunities(afterDiscard, [...visible, draw.tile], { dingque: player.dingque, melds: player.melds }).total > 0
    })
    return entersTenpai
      ? [{ ...draw, probability: unknownTiles === 0 ? 0 : draw.remaining / unknownTiles }]
      : []
  })
}

function buildPatternTrends(state: GameState, playerId: PlayerId, discarded: TileInstance): PatternTrend[] {
  const player = state.players[playerId]
  const before = [...player.hand, ...player.melds.flatMap(meld => meld.tiles)]
  const after = before.filter(tile => tile.id !== discarded.id)
  const activeTypes = MILESTONE_1_RULES.tileTypes.filter(type => type !== player.dingque)
  const counts = (tiles: readonly TileInstance[], type: Tile['type']) => tiles.filter(tile => tile.type === type).length
  const dominant = [...activeTypes].sort((a, b) => counts(after, b) - counts(after, a))[0]
  const dominantCount = dominant === undefined ? 0 : counts(after, dominant)
  const trends: PatternTrend[] = []

  if (dominant !== undefined && dominantCount >= 7 && dominantCount / Math.max(1, after.length) >= 0.65) {
    trends.push({
      pattern: 'qingyise',
      direction: discarded.type === dominant ? 'break' : 'keep',
      strength: dominantCount >= 10 ? 'strong' : 'forming',
      summary: discarded.type === dominant
        ? `打${discarded.value}${discarded.type}会削弱清一色：有效结构只剩${dominantCount}张${dominant}。`
        : `保留${dominantCount}张${dominant}主色，清一色仍在成型；若公开威胁升高，优先改走快胡。`,
    })
  }

  const pairLike = (tiles: readonly TileInstance[]) => {
    const groups = new Map<string, number>()
    for (const tile of tiles)
      groups.set(`${tile.type}-${tile.value}`, (groups.get(`${tile.type}-${tile.value}`) ?? 0) + 1)
    return [...groups.values()].filter(count => count >= 2).length
  }
  const beforePairs = pairLike(before)
  const afterPairs = pairLike(after)
  if (afterPairs >= 4 || beforePairs >= 5) {
    trends.push({
      pattern: 'duiduihu',
      direction: afterPairs < beforePairs ? 'break' : 'keep',
      strength: afterPairs >= 5 ? 'strong' : 'forming',
      summary: afterPairs < beforePairs
        ? `打${discarded.value}${discarded.type}拆掉一组对子/刻子，对对胡胚子从${beforePairs}组降到${afterPairs}组。`
        : `保留${afterPairs}组对子/刻子，对对胡胚子还在；但不能为追对倒牺牲当前速度。`,
    })
  }

  const kongGroups = new Map<string, number>()
  for (const tile of before)
    kongGroups.set(`${tile.type}-${tile.value}`, (kongGroups.get(`${tile.type}-${tile.value}`) ?? 0) + 1)
  const kongPotential = [...kongGroups.entries()].find(([, count]) => count >= 3)
  if (kongPotential !== undefined || player.melds.some(meld => meld.kind.includes('Gang'))) {
    const [key, count] = kongPotential ?? ['', 0]
    const [value, type] = key.split('-')
    const breaksKong = discarded.type === type && discarded.value === Number(value)
    trends.push({
      pattern: 'konghua',
      direction: breaksKong ? 'break' : 'keep',
      strength: count >= 3 ? 'forming' : 'weak',
      summary: breaksKong
        ? `打${discarded.value}${discarded.type}放弃${count}张同牌的杠胚；杠上花需要先成杠，不能把它当现成收益。`
        : kongPotential === undefined
          ? '已有杠结构；杠上花仍取决于后续补张与牌墙，当前只算作可选上限。'
          : `保留${count}张${value}${type}杠胚；是否追杠要看牌墙和公开危险，不能为杠强行拖慢下叫。`,
    })
  }
  return trends
}

function calculateTrendAdjustment(state: GameState, playerId: PlayerId, tile: TileInstance, trends: PatternTrend[]): number {
  const reminder = buildStrategicReminder(state, playerId)
  const threats = detectOpponentThreats(state, playerId)
  const strongKeeps = trends.filter(trend => trend.direction === 'keep' && trend.strength === 'strong').length
  const strongBreaks = trends.filter(trend => trend.direction === 'break' && trend.strength === 'strong').length
  const formingBreaks = trends.filter(trend => trend.direction === 'break' && trend.strength === 'forming').length
  const feedsThreat = threats.some(threat => threat.targetType === tile.type)

  // 战略只能微调接近的牌效选择：公开大牌危险时惩罚喂牌；优势窗口才奖励明确胚子。
  // 这不是完整 EV，也绝不允许番型幻想覆盖活张与下叫速度。
  const patternAdjustment = reminder.posture === 'press' ? strongKeeps * 0.025 : 0
  const breakPenalty = strongBreaks * 0.05 + formingBreaks * 0.015
  const dangerPenalty = feedsThreat ? 0.15 : 0
  return patternAdjustment - breakPenalty - dangerPenalty
}

function analyzeDiscard(tile: TileInstance, state: GameState, playerId: PlayerId, visible: TileInstance[], unknownTiles: number): DiscardCandidateAnalysis {
  const player = state.players[playerId]
  const handAfter = player.hand.filter(candidate => candidate.id !== tile.id)
  const result = waitAnalysis(handAfter, [...visible, tile], state, playerId, unknownTiles)
  const theoreticalWaits = result.waits
  const liveWaits = theoreticalWaits.filter(wait => wait.remaining > 0)
  const weightedTotal = liveWaits.reduce((sum, wait) => sum + wait.remaining, 0)
  const averageFan = weightedTotal === 0 ? null : liveWaits.reduce((sum, wait) => sum + wait.baseFan * wait.remaining, 0) / weightedTotal
  const averagePoints = weightedTotal === 0 ? null : liveWaits.reduce((sum, wait) => sum + wait.points * wait.remaining, 0) / weightedTotal
  const probability = weightedTotal === 0 || unknownTiles === 0 ? null : Math.min(1, weightedTotal / unknownTiles)
  const tenpaiPaths = probability === null ? tenpaiPathAnalysis(handAfter, [...visible, tile], state, playerId, unknownTiles) : []
  const tenpaiProbability = tenpaiPaths.length === 0 || unknownTiles === 0
    ? null
    : Math.min(1, tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0) / unknownTiles)
  const brokenCombos = brokenStrongCombos(player.hand, tile)
  const patternTrends = buildPatternTrends(state, playerId, tile)
  const trendAdjustment = calculateTrendAdjustment(state, playerId, tile, patternTrends)
  // 已听：直接和牌的单巡基础分期望；未听：下一摸转听概率 × 机会数，均不伪装为多巡 EV。
  // 趋势仅在速度基础上微调，且公开危险门的惩罚优先于任何做大胚子。
  const valueIndex = (probability !== null && averagePoints !== null
    ? probability * averagePoints - brokenCombos.length * 0.02
    : (tenpaiProbability ?? 0) * result.opportunity - brokenCombos.length * 0.02) + trendAdjustment
  return {
    tile: { type: tile.type, value: tile.value },
    opportunity: result.opportunity,
    structuralWaits: result.structuralWaits,
    nextDrawWinProbability: probability,
    nextDrawTenpaiProbability: tenpaiProbability,
    tenpaiPaths,
    waits: liveWaits,
    theoreticalWaits,
    averageFan,
    averagePoints,
    trendAdjustment,
    valueIndex,
    patternTrends,
    brokenCombos,
    // 弃牌首选在所有候选完成同一套价值计算后统一标记；不能从另一套 AI 排序借结论。
    isRecommended: false,
  }
}

function analyzeHuDecision(state: GameState, playerId: PlayerId, visible: TileInstance[]): HuDecisionAnalysis | null {
  const action = getLegalActions(state, playerId).find((candidate): candidate is Extract<LegalAction, { type: 'hu' }> => candidate.type === 'hu')
  if (action === undefined)
    return null
  const player = state.players[playerId]
  const winningTile = state.phase === 'responding' ? state.responseWindow?.tile : undefined
  const score = calculateScore(winningTile === undefined ? player.hand : [...player.hand, winningTile], {
    melds: player.melds,
    dingque: player.dingque,
  })
  const continuation = waitAnalysis(player.hand, visible, state, playerId, Math.max(1, state.wall.length))
  const threat = detectOpponentThreats(state)[0]
  // 默认先兑现；只有低价值、牌墙宽且有明确高机会暗手，并且没有公开大牌威胁时，才允许提示“可考虑继续”。
  const recommendation: HuDecisionAnalysis['recommendation'] = action.value <= 1
    && state.wall.length > 45
    && continuation.opportunity >= 8
    && threat === undefined
    ? 'continue'
    : 'hu'
  return {
    action,
    points: action.value,
    fan: score?.scoringFan ?? 0,
    wallTiles: state.wall.length,
    continueOpportunity: continuation.opportunity,
    continueWaits: continuation.waits.filter(wait => wait.remaining > 0),
    mustBeatPassedValue: state.phase === 'responding',
    recommendation,
  }
}

function analyzePeng(state: GameState, playerId: PlayerId, visible: TileInstance[], recommendation: GameCommand | null): PengCandidateAnalysis | null {
  const action = getLegalActions(state, playerId).find((candidate): candidate is Extract<GameCommand, { type: 'peng' }> => candidate.type === 'peng')
  const window = state.responseWindow
  if (action === undefined || window === null)
    return null
  const player = state.players[playerId]
  const matching = player.hand.filter(tile => sameTile(tile, window.tile)).slice(0, 2)
  if (matching.length !== 2)
    return null
  const afterPeng = player.hand.filter(tile => !matching.some(match => match.id === tile.id))
  const melds = [...player.melds, { kind: 'peng' as const, tiles: [...matching, window.tile], fromPlayer: window.sourcePlayer }]
  const beforeOpportunity = countOpportunities(player.hand, visible, { dingque: player.dingque, melds: player.melds }).total
  const legalDiscards = getLegalDiscards(afterPeng, player.dingque)
  const options = legalDiscards.map((discard) => {
    const hand = afterPeng.filter(tile => tile.id !== discard.id)
    const opportunity = countOpportunities(hand, [...visible, ...matching, window.tile], { dingque: player.dingque, melds }).total
    return { tile: discard, opportunity }
  }).sort((a, b) => b.opportunity - a.opportunity || a.tile.value - b.tile.value)
  const best = options[0]
  const meldGain = 1 + (player.melds.length === 0 ? 1 : 0)
  return {
    action,
    tile: { type: window.tile.type, value: window.tile.value },
    beforeOpportunity,
    afterBestDiscardOpportunity: best?.opportunity ?? 0,
    bestDiscard: best === undefined ? null : { type: best.tile.type, value: best.tile.value },
    forcedDiscardCount: options.length,
    meldGain,
    isRecommended: recommendation?.type === 'peng',
  }
}

function coachObjective(reminder: StrategicReminder, chosen: DiscardCandidateAnalysis | undefined): CoachMessage['objective'] {
  if (reminder.posture === 'retreat')
    return 'defend'
  if (reminder.posture === 'press')
    return 'press'
  return chosen?.nextDrawWinProbability !== null ? 'convert' : 'race'
}

function objectiveLabel(objective: CoachMessage['objective']): string {
  return objective === 'defend' ? '本巡目标：先防守' : objective === 'press' ? '本巡目标：继续做大' : objective === 'convert' ? '本巡目标：尽快兑现' : '本巡目标：抢先下叫'
}

function buildCoachMessage(state: GameState, chosen: DiscardCandidateAnalysis | undefined, recommendation: GameCommand | null): CoachMessage {
  const reminder = buildStrategicReminder(state)
  const objective = coachObjective(reminder, chosen)
  const threat = detectOpponentThreats(state)[0]
  if (threat !== undefined) {
    return {
      objective,
      mode: 'warning',
      headline: `${objectiveLabel(objective)} · ${threat.position}睡宽床`,
      guidance: `他已清定缺并副露${threat.meldCount}组${threat.targetType}，公开结构已构成大牌压力。此时不是继续比较谁的番更高，而是优先找不喂${threat.targetType}、又能缩短下叫距离的牌；做大趋势只能排在安全之后。`,
      evidence: [`${threat.position}：副露${threat.meldCount}组${threat.targetType}`, `已清定缺${state.players[threat.playerId].dingque}`, '证据仅来自公开副露、定缺与牌河'],
      practice: '先圈出不喂危险门的候选，再在其中选择活张更宽的一张。',
    }
  }
  if (reminder.posture === 'retreat') {
    return {
      objective,
      mode: 'warning',
      headline: `${objectiveLabel(objective)} · ${reminder.title}`,
      guidance: `${reminder.summary} 这一巡只要能减少风险并靠近听牌，就比勉强保留高番胚子更有价值。`,
      evidence: reminder.signals,
      practice: '按“先安全、再下叫、最后才是番型”的顺序筛选候选弃牌。',
    }
  }
  if (chosen !== undefined && chosen.nextDrawWinProbability !== null) {
    const waits = chosen.waits.map(wait => `${wait.tile.value}${wait.tile.type}×${wait.remaining}`).join('、')
    return {
      objective,
      mode: 'decision',
      headline: `${objectiveLabel(objective)} · 打 ${chosen.tile.value}${chosen.tile.type}`,
      guidance: `你已听 ${waits || '暂无活叫'}，共 ${chosen.opportunity} 张活张。现在的重点是把这次可兑现的机会拿到手；除非公开局势明确支持做大，否则不要为了虚拟番型拆宽叫。`,
      evidence: [`${chosen.structuralWaits} 种叫口 / ${chosen.opportunity} 张活张`, `下一摸直接和牌率 ${(chosen.nextDrawWinProbability * 100).toFixed(1)}%`, `金线：打出${goldenLineLabel(chosen.tile)}；比较候选时要看同线 1-4-7 / 2-5-8 / 3-6-9 的进张是否被一并切断`, chosen.brokenCombos.length === 0 ? '未拆强组合' : `会拆 ${chosen.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 强组合`],
      practice: '点选另一张候选牌：先比活张和叫口，再核对是否把同门金线的可接进张一并打散。',
    }
  }
  return {
    objective,
    mode: 'observe',
    headline: `${objectiveLabel(objective)} · ${recommendation === null ? '等待局势变化' : '先保留转听空间'}`,
    guidance: '当前还没形成可兑现的直接叫口。先保留更多能把手牌推向听牌的进张；同缺、副露或危险门一旦出现，再把目标切到抢跑或防守。',
    evidence: reminder.signals,
    practice: '比较候选时先看谁的转听进张更多，再看是否拆强组合或给对手危险门。',
  }
}

/**
 * 基于玩家可见信息生成实时辅助。
 * 已听：概率 = 有效和牌张 / 全部未知牌；未听：概率 = 下一摸后经一次正常弃牌可入听的进张 / 全部未知牌。
 * 番数只计算已经成牌的基础番与基础分；海底、杠上花等情境番不提前虚构。
 * 来源：理论册第一、二节及成都册第二章第一节的机会数计算方法。
 */
export function buildImmediateDiscardFeedback(analysis: DiscardAssistantAnalysis, tile: Tile): ImmediateDiscardFeedback | null {
  const actual = analysis.candidates.find(candidate => sameTile(candidate.tile, tile))
  const best = analysis.candidates[0]
  if (actual === undefined || best === undefined || sameTile(actual.tile, best.tile))
    return null

  const opportunityLoss = best.opportunity - actual.opportunity
  const bestTile = `${best.tile.value}${best.tile.type}`
  const actualTile = `${actual.tile.value}${actual.tile.type}`
  const threat = analysis.coach.mode === 'warning' && analysis.coach.headline.includes('睡宽床')
  if (threat && actual.trendAdjustment <= -0.15 && best.trendAdjustment > actual.trendAdjustment) {
    return { kind: 'risk', message: `这手打 ${actualTile} 踩进公开危险门；改打 ${bestTile} 可先避开喂牌压力。` }
  }
  if (opportunityLoss >= 3) {
    return { kind: 'route', message: `这手打 ${actualTile} 少留 ${opportunityLoss} 张有效进张；当时打 ${bestTile} 的进张路更宽。` }
  }
  const brokeStrongRoute = actual.brokenCombos.length > best.brokenCombos.length
  if (brokeStrongRoute && best.opportunity >= actual.opportunity) {
    return { kind: 'value', message: `这手为做牌拆开了强组合，但没有换到更快下叫；${bestTile} 的结构更稳。` }
  }
  return null
}

export function buildDiscardAssistant(state: GameState, playerId: PlayerId = 0): DiscardAssistantAnalysis {
  const player = state.players[playerId]
  const visible = publicTiles(state)
  const known = knownTiles(state, playerId)
  const totalTileCount = MILESTONE_1_RULES.tileTypes.length * MILESTONE_1_RULES.values.length * MILESTONE_1_RULES.copiesPerTile
  const unknownTiles = Math.max(0, totalTileCount - known.length)
  const engineRecommendation = chooseAICommand(state, playerId)
  const legalDiscards = getLegalActions(state, playerId).filter(action => action.type === 'discard')
  const seenTypes = new Set<string>()
  const rankedCandidates = legalDiscards.flatMap((action) => {
    const tile = player.hand.find(candidate => candidate.id === action.tileId)
    if (tile === undefined)
      return []
    const key = `${tile.type}-${tile.value}`
    if (seenTypes.has(key))
      return []
    seenTypes.add(key)
    return [analyzeDiscard(tile, state, playerId, visible, unknownTiles)]
  }).sort((a, b) => b.valueIndex - a.valueIndex || b.opportunity - a.opportunity || a.tile.value - b.tile.value)
  // 教学助手的“首选”只能来自它展示的同一排序，避免 AI 结构评分和候选价值排序各说各话。
  const candidates = rankedCandidates.map((candidate, index) => ({ ...candidate, isRecommended: index === 0 }))
  const recommendation = candidates[0] === undefined
    ? engineRecommendation
    : (() => {
        const matchingAction = legalDiscards.find(action => {
          const tile = player.hand.find(item => item.id === action.tileId)
          return tile?.type === candidates[0].tile.type && tile.value === candidates[0].tile.value
        })
        return matchingAction === undefined ? engineRecommendation : { ...matchingAction, playerId }
      })()

  const pengCandidate = analyzePeng(state, playerId, visible, recommendation)
  const huDecision = analyzeHuDecision(state, playerId, visible)
  const chosen = candidates[0]
  const current = chosen ?? (() => {
    const result = waitAnalysis(player.hand, visible, state, playerId, unknownTiles)
    return {
      opportunity: result.opportunity,
      structuralWaits: result.structuralWaits,
      waits: result.waits.filter(wait => wait.remaining > 0),
      nextDrawWinProbability: result.opportunity === 0 || unknownTiles === 0 ? null : result.opportunity / unknownTiles,
    }
  })()
  const reason = recommendation === null
    ? '当前不是你的决策窗口；数据按现有手牌与公开信息持续更新。'
    : chosen === undefined
      ? getAIReason(state, playerId, recommendation)
      : chosen.nextDrawWinProbability !== null
        ? `打后已听 ${chosen.structuralWaits} 种叫口、${chosen.opportunity} 张活张，机会质量${OPPORTUNITY_RATING_LABEL[rateOpportunity(chosen.opportunity)]}，下一摸直接和牌率 ${(chosen.nextDrawWinProbability * 100).toFixed(1)}%；${chosen.brokenCombos.length === 0 ? '不拆强组合' : `会拆 ${chosen.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 强组合`}。`
        : `打后尚未下叫，但下一摸入听率 ${((chosen.nextDrawTenpaiProbability ?? 0) * 100).toFixed(1)}%，可由 ${chosen.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)} 张进张转入听牌；${chosen.brokenCombos.length === 0 ? '不拆强组合' : `会拆 ${chosen.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 强组合`}。`

  return {
    recommendation,
    recommendationLabel: commandLabel(recommendation, state),
    reason,
    theoryBasis: [
      '机会数：已听时为有效和牌张；未听时另展示下一摸后可转听的有效进张，不能混成一个数字。',
      '强组合：2-7、3-7、2-8、3-8需避免无收益拆解。',
      '番数：只展示已成牌结构的基础番；尚未下叫时不虚构番数，先展示入听路径。',
      '概率：已听为下一摸直接和牌率；未听为下一摸经一次正常弃牌进入听牌的概率，均按公开信息扣张。',
      '统一决策：候选排序、首选标记、推荐动作与逐手讲解均来自同一候选价值模型；不再混用另一套结构评分。',
      '胡牌取舍：立即胡是确定分数；继续做大只展示牌墙、当前机会数、公开威胁与过手不胡门槛，不把未发生的后续牌局伪装成胜率。',
    ],
    knownTiles: known.length,
    unknownTiles,
    wallTiles: state.wall.length,
    knownTileCounts: tileCounts(known).filter(item => item.count > 0),
    opportunity: current.opportunity,
    structuralWaits: current.structuralWaits,
    nextDrawWinProbability: current.nextDrawWinProbability,
    waits: current.waits,
    candidates,
    pengCandidate,
    huDecision,
    coach: buildCoachMessage(state, chosen, recommendation),
  }
}

function candidateWaitLabel(candidate: DiscardCandidateAnalysis): string {
  return candidate.theoreticalWaits.map(wait => wait.remaining > 0
    ? `${wait.tile.value}${wait.tile.type}×${wait.remaining}`
    : `${wait.tile.value}${wait.tile.type}（理论死听·0张）`).join('、')
}

/**
 * 生成“点一张牌就讲一手”的教学结论。
 * 结论严格来自候选牌效数据；睡宽床等风险只用公开副露/牌河推断，不读取暗牌。
 */
export function buildCandidateLesson(analysis: DiscardAssistantAnalysis, candidate: DiscardCandidateAnalysis): CandidateLesson {
  const best = analysis.candidates[0]
  const threat = analysis.coach.mode === 'warning' ? analysis.coach.headline : null
  const currentWaits = candidate.waits.reduce((sum, wait) => sum + wait.remaining, 0)
  const bestWaits = best?.waits.reduce((sum, wait) => sum + wait.remaining, 0) ?? 0
  const isRecommended = candidate.isRecommended
  const verdict: CandidateLesson['verdict'] = isRecommended
    ? 'recommended'
    : candidate.valueIndex >= (best?.valueIndex ?? 0) * 0.86 ? 'playable' : 'inferior'
  const tenpaiText = candidate.nextDrawWinProbability !== null
    ? `会听 ${candidateWaitLabel(candidate) || '无活叫'}，共 ${currentWaits} 张活张，下一摸直接和牌率 ${(candidate.nextDrawWinProbability * 100).toFixed(1)}%。`
    : `尚未下叫；下一摸后可转听 ${candidate.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)} 张，转听率 ${((candidate.nextDrawTenpaiProbability ?? 0) * 100).toFixed(1)}%。`
  const patternText = candidate.patternTrends.map(trend => trend.summary).join(' ')
  const strongPlans = candidate.patternTrends.filter(trend => trend.direction === 'keep' && trend.strength === 'strong')
  const objective = analysis.coach.objective
  const tacticalText = objective === 'defend'
    ? `本巡目标是先防守。${threat ? `公开局势已有“${threat}”，` : ''}${strongPlans.length > 0 ? `即使保留${strongPlans.map(trend => patternLabel(trend.pattern)).join('、')}胚子，也不能优先于不喂危险门和尽快下叫。` : '任何贪大牌选择都要先证明它不增加危险门。'}`
    : objective === 'convert'
      ? `本巡目标是尽快兑现。${strongPlans.length > 0 ? `这手仍有${strongPlans.map(trend => patternLabel(trend.pattern)).join('、')}胚子，但没有明确收益时不该为了它拆宽叫。` : '先把现有的宽叫兑现，再考虑下一手的价值。'}`
      : objective === 'press' && strongPlans.length > 0 && (candidate.nextDrawWinProbability !== null ? currentWaits >= 4 : (candidate.nextDrawTenpaiProbability ?? 0) >= 0.1)
        ? `本巡允许继续做大：牌型具备${strongPlans.map(trend => patternLabel(trend.pattern)).join('、')}胚子，且速度没有塌；每巡仍要复核活张和牌墙。`
        : strongPlans.length > 0
          ? `本巡先抢下叫。牌型虽有${strongPlans.map(trend => patternLabel(trend.pattern)).join('、')}胚子，但当前速度不足；它只是上限，不足以压过快胡与下叫。`
          : '本巡先抢下叫：目前没有足够硬的做大证据，先把速度和可兑现叫口放在前面。'

  if (isRecommended) {
    return {
      verdict,
      headline: `可以打 ${candidate.tile.value}${candidate.tile.type}：这是当前最优解`,
      explanation: `${tenpaiText}${candidate.brokenCombos.length === 0 ? ' 同时没有无收益拆强组合。' : ` 代价是拆开 ${candidate.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 强组合，但牌效收益足以覆盖。`} ${patternText} ${tacticalText}`,
      evidence: [
        `候选排序第 1 / ${analysis.candidates.length}`,
        candidate.nextDrawWinProbability !== null ? `${candidate.structuralWaits} 种理论叫口 · ${currentWaits} 张活张` : `下一摸转听进张 ${candidate.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)} 张`,
        ...candidate.theoreticalWaits.filter(wait => wait.remaining === 0).map(wait => `${wait.tile.value}${wait.tile.type} 已打光 · 理论死听`),
        candidate.brokenCombos.length === 0 ? '未拆强组合' : `拆 ${candidate.brokenCombos.length} 组强组合`,
        trendAdjustmentLabel(candidate),
        ...candidate.patternTrends.map(trend => `${patternLabel(trend.pattern)}：${trend.direction === 'keep' ? '保留' : '削弱'}趋势`),
      ],
      nextQuestion: '再点一张你犹豫的牌，重点比较“叫口宽度”和“是否喂危险门”。',
    }
  }

  const gap = candidate.nextDrawWinProbability !== null && best?.nextDrawWinProbability !== null
    ? `比推荐少 ${Math.max(0, bestWaits - currentWaits)} 张活张`
    : `转听进张比推荐少 ${Math.max(0, (best?.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0) ?? 0) - candidate.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0))} 张`
  return {
    verdict,
    headline: `打 ${candidate.tile.value}${candidate.tile.type}${verdict === 'playable' ? '：可打，但不是首选' : '：不建议优先考虑'}`,
    explanation: `${tenpaiText} 相比推荐的“打 ${best?.tile.value}${best?.tile.type ?? ''}”，${gap}。${candidate.brokenCombos.length === 0 ? '' : ` 而且会拆 ${candidate.brokenCombos.map(([a, b]) => `${a}-${b}`).join('、')} 强组合。`} ${patternText} ${tacticalText}`,
    evidence: [
      `候选排序第 ${analysis.candidates.findIndex(item => item.tile.type === candidate.tile.type && item.tile.value === candidate.tile.value) + 1} / ${analysis.candidates.length}`,
      candidate.nextDrawWinProbability !== null ? `${candidate.structuralWaits} 种理论叫口 · ${currentWaits} 张活张` : `下一摸转听进张 ${candidate.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)} 张`,
      ...candidate.theoreticalWaits.filter(wait => wait.remaining === 0).map(wait => `${wait.tile.value}${wait.tile.type} 已打光 · 理论死听`),
      trendAdjustmentLabel(candidate),
      ...candidate.patternTrends.map(trend => `${patternLabel(trend.pattern)}：${trend.direction === 'keep' ? '保留' : '削弱'}趋势`),
      `推荐方案：打 ${best?.tile.value}${best?.tile.type ?? ''}`,
    ],
    nextQuestion: '问自己：这张牌带来的番数，是否真的补得回少掉的活张与速度？',
  }
}

export function buildHuLesson(analysis: DiscardAssistantAnalysis): HuLesson | null {
  const decision = analysis.huDecision
  if (decision === null)
    return null
  const waits = decision.continueWaits.map(wait => `${wait.tile.value}${wait.tile.type}×${wait.remaining}`).join('、') || '暂无可核验活叫'
  const isHu = decision.recommendation === 'hu'
  return {
    verdict: isHu ? 'recommended' : 'playable',
    headline: isHu ? `建议现在胡：${decision.points}分已落袋` : `可考虑过胡追价值，但不是免费升级`,
    explanation: isHu
      ? `当前可直接兑现 ${decision.points} 分（${decision.fan}番）。继续做大必须先放弃这次胡牌，之后还要重新摸进并保持更高牌值；${decision.wallTiles <= 30 ? '牌墙已短，追番的兑现窗口更窄。' : '牌墙尚有空间，但也不能把“有潜力”当成必然收益。'}`
      : `这次只有 ${decision.points} 分，牌墙仍有 ${decision.wallTiles} 张，暗手后续还有 ${decision.continueOpportunity} 张机会数；可以把“过”当作主动投资，但代价是放弃眼前分数，并承担后续摸不到、被抢胡或被迫降速的风险。`,
    evidence: [
      `立即胡：${decision.points}分 · ${decision.fan}番`,
      `继续后当前可核验机会数：${decision.continueOpportunity} 张`,
      `继续路径的现有活叫：${waits}`,
      `牌墙剩余：${decision.wallTiles} 张`,
      ...(decision.mustBeatPassedValue ? ['过胡后触发“过手不胡”门槛：后续必须胡到更高分才可再胡'] : []),
    ],
    nextQuestion: isHu
      ? '如果想追大，先问：多出来的番数是否能覆盖“失去这次确定分数 + 后续重新成牌”的风险？'
      : '把过胡当投资：下一轮若没把机会数或番型优势做出来，就应停止追加，优先兑现。',
  }
}

export function buildPengLesson(analysis: DiscardAssistantAnalysis): PengLesson | null {
  const candidate = analysis.pengCandidate
  if (candidate === null)
    return null
  const delta = candidate.afterBestDiscardOpportunity - candidate.beforeOpportunity
  const verdict: PengLesson['verdict'] = candidate.isRecommended
    ? 'recommended'
    : delta >= 0 ? 'playable' : 'inferior'
  const tileLabel = `${candidate.tile.value}${candidate.tile.type}`
  const bestDiscardLabel = candidate.bestDiscard === null ? '暂无后续弃张' : `碰后优先打 ${candidate.bestDiscard.value}${candidate.bestDiscard.type}`
  const headline = candidate.isRecommended
    ? `建议碰 ${tileLabel}：副露能换来速度`
    : verdict === 'playable'
      ? `碰 ${tileLabel}可考虑，但先看速度代价`
      : `不建议碰 ${tileLabel}：先保留暗手弹性`
  const explanation = candidate.isRecommended
    ? `碰后形成一组明刻，${bestDiscardLabel}，可把手牌推进到 ${candidate.afterBestDiscardOpportunity} 张机会数。此处的速度收益大于失去门清弹性的代价。`
    : delta >= 0
      ? `碰后${bestDiscardLabel}，机会数可到 ${candidate.afterBestDiscardOpportunity} 张，与不碰的 ${candidate.beforeOpportunity} 张相比没有明显变差；是否碰取决于你是否要抢节奏，而不是“有碰必碰”。`
      : `碰后还要强制弃一张，${bestDiscardLabel}，机会数会从 ${candidate.beforeOpportunity} 张降到 ${candidate.afterBestDiscardOpportunity} 张。除非公开局势要求抢速度，否则保留暗手更稳。`
  return {
    verdict,
    headline,
    explanation,
    evidence: [
      `不碰：当前机会数 ${candidate.beforeOpportunity} 张`,
      `碰后最佳：${candidate.afterBestDiscardOpportunity} 张机会数`,
      bestDiscardLabel,
      `明刻速度收益：+${candidate.meldGain}（只作结构启发，不伪装为胜率）`,
    ],
    nextQuestion: '先点“碰牌讲解”看结论；再问自己：碰后被迫打出的那张牌，会不会破坏叫口或喂危险门？',
  }
}

export function countKnownCopies(analysis: DiscardAssistantAnalysis, tile: Tile): number {
  return analysis.knownTileCounts.find(item => sameTile(item.tile, tile))?.count ?? 0
}
