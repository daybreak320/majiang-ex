import type { WaitShape } from '../knowledge/mahjongTheory'
import type { Tile, TileType } from '../types'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { brokenStrongCombos, classifyWaitShape, countOpportunities, rateOpportunity } from '../knowledge/mahjongTheory'
import { VALID_TYPES } from '../types'
import { sortTilesByMahjongOrder } from '../utils/majiang'
import { trackAnswer } from '../utils/tracker'
import { AnimatedMajiangTile } from './AnimatedMajiangTile'
import { MajiangTile } from './MajiangTile'
import { SortButton } from './SortButton'

interface DiscardModeProps {
  onComplete: (score: number, time: number) => void
}

interface CandidateAnalysis {
  tile: Tile
  /** 打出后 13 张手牌的机会数（有效进张剩余张数总和） */
  opportunityTotal: number
  /** 有效进张明细 */
  waits: Array<{ tile: Tile, remaining: number }>
  /** 听牌形态 */
  waitShape: WaitShape
  /** 打出后拆散的强组合（27/28/37/38） */
  brokeCombos: ReadonlyArray<readonly [number, number]>
  /** 剩余手牌形状分（辅助维度） */
  shapeScore: number
  /** 综合推荐分：机会数主导，拆强组合重罚，形状分做次级排序 */
  score: number
  /** 理论分析理由 */
  reasons: string[]
}

interface HandState {
  hand: Tile[]
  /** 四川麻将定缺：仍持有该门时必须优先清掉，否则终局会有花猪风险。 */
  dingque: TileType
  analyses: CandidateAnalysis[]
  best: CandidateAnalysis
  /** 当前定缺规则允许打出的候选；仍持缺门时只能打缺门。 */
  legalKeys: Set<string>
  /** 机会数并列且不额外拆强组合的候选（均视为正解） */
  correctKeys: Set<string>
}

const WAIT_SHAPE_LABEL: Record<WaitShape, string> = {
  single: '单吊',
  kanchan: '间张听',
  twoSided: '两头听',
  threeSided: '三面听以上',
  other: '未听牌',
}

const OPP_RATING_LABEL: Record<ReturnType<typeof rateOpportunity>, string> = {
  excellent: '优',
  good: '良',
  fair: '中',
  poor: '差',
}

function sameTile(a: Tile, b: Tile): boolean {
  return a.type === b.type && a.value === b.value
}

function tileKey(tile: Tile): string {
  return `${tile.type}-${tile.value}`
}

function formatTile(tile: Tile): string {
  return `${tile.value}${tile.type}`
}

function removeOneTile(hand: Tile[], target: Tile): Tile[] {
  const targetIndex = hand.findIndex(tile => sameTile(tile, target))
  if (targetIndex === -1)
    return hand

  return hand.filter((_, index) => index !== targetIndex)
}

// ---------------------------------------------------------------------------
// 剩余手牌形状评估（辅助维度：组合/对子/搭子结构）
// ---------------------------------------------------------------------------

interface HandShape {
  score: number
  triplets: number
  pairs: number
  sequences: number
  adjacentPairs: number
  gapPairs: number
  isolatedTiles: number
}

function evaluateRemainingShape(hand: Tile[]): HandShape {
  let triplets = 0
  let pairs = 0
  let sequences = 0
  let adjacentPairs = 0
  let gapPairs = 0
  let isolatedTiles = 0
  let middleTileWeight = 0

  for (const type of VALID_TYPES) {
    const counts = Array.from({ length: 10 }, () => 0)
    for (const tile of hand) {
      if (tile.type === type)
        counts[tile.value] += 1
    }

    for (let value = 1; value <= 9; value++) {
      const count = counts[value]
      if (count === 0)
        continue

      if (count >= 3)
        triplets += 1
      if (count >= 2)
        pairs += 1

      if (value >= 3 && value <= 7)
        middleTileWeight += count

      const hasDirect = counts[value - 1] > 0 || counts[value + 1] > 0
      const hasGap = counts[value - 2] > 0 || counts[value + 2] > 0
      if (count === 1 && !hasDirect && !hasGap)
        isolatedTiles += 1
    }

    for (let value = 1; value <= 7; value++)
      sequences += Math.min(counts[value], counts[value + 1], counts[value + 2])

    for (let value = 1; value <= 8; value++)
      adjacentPairs += Math.min(counts[value], counts[value + 1])

    for (let value = 1; value <= 7; value++)
      gapPairs += Math.min(counts[value], counts[value + 2])
  }

  const score = triplets * 30
    + sequences * 26
    + pairs * 18
    + adjacentPairs * 10
    + gapPairs * 5
    + middleTileWeight
    - isolatedTiles * 12

  return {
    score,
    triplets,
    pairs,
    sequences,
    adjacentPairs,
    gapPairs,
    isolatedTiles,
  }
}

// ---------------------------------------------------------------------------
// 理论驱动的候选分析（朱扬《机会数理论》）
// 机会数 = 打出后能让手牌直接听牌的有效进张剩余张数之和。
// ---------------------------------------------------------------------------

function buildReasons(tile: Tile, opportunityTotal: number, waits: CandidateAnalysis['waits'], waitShape: WaitShape, brokeCombos: ReadonlyArray<readonly [number, number]>, shape: HandShape): string[] {
  const reasons: string[] = []
  const rating = OPP_RATING_LABEL[rateOpportunity(opportunityTotal)]

  if (waits.length > 0) {
    const waitText = waits.map(wait => `${formatTile(wait.tile)}×${wait.remaining}`).join('、')
    reasons.push(`打出 ${formatTile(tile)} 后机会数 ${opportunityTotal} 张（${rating}），有效进张：${waitText}`)
    reasons.push(`听牌形态：${WAIT_SHAPE_LABEL[waitShape]}（进张 ${waits.length} 种）`)
  }
  else {
    reasons.push(`打出 ${formatTile(tile)} 后手牌未形成听牌结构，机会数 0——还需要两次以上进张才能听牌`)
  }

  if (brokeCombos.length > 0) {
    reasons.push(`⚠️ 拆散强组合 ${brokeCombos.map(([a, b]) => `${a}-${b}`).join('、')}：两张牌辐射 1-9 全部数字，朱扬原话"千万别拆"`)
  }
  else {
    reasons.push(`结构保持完好：${shape.triplets + shape.sequences} 组成型面子、${shape.pairs} 组对子、${shape.adjacentPairs + shape.gapPairs} 组搭子未被破坏`)
  }

  return reasons
}

function analyzeCandidate(tile: Tile, hand: Tile[]): CandidateAnalysis {
  const remaining = removeOneTile(hand, tile)
  const opportunity = countOpportunities(remaining)
  const waitShape = classifyWaitShape(remaining, opportunity.structuralWaits)
  const brokeCombos = brokenStrongCombos(hand, tile)
  const shape = evaluateRemainingShape(remaining)

  // 综合分：机会数是主准绳（朱扬：机会数是取舍的准绳），
  // 拆强组合严重惩罚（复盘启发式 tileEfficiency/high），
  // 形状分做同机会数下的次级排序。
  const score = opportunity.total * 100
    + shape.score
    - brokeCombos.length * 300

  return {
    tile,
    opportunityTotal: opportunity.total,
    waits: opportunity.waits,
    waitShape,
    brokeCombos,
    shapeScore: shape.score,
    score,
    reasons: buildReasons(tile, opportunity.total, opportunity.waits, waitShape, brokeCombos, shape),
  }
}

function analyzeHand(hand: Tile[], dingque: TileType): HandState {
  const seen = new Set<string>()
  const analyses: CandidateAnalysis[] = []
  const hasDingqueTiles = hand.some(tile => tile.type === dingque)

  for (const tile of hand) {
    const key = tileKey(tile)
    if (seen.has(key))
      continue
    seen.add(key)
    analyses.push(analyzeCandidate(tile, hand))
  }

  const legalAnalyses = hasDingqueTiles
    ? analyses.filter(analysis => analysis.tile.type === dingque)
    : analyses
  const best = legalAnalyses.reduce((top, current) => (current.score > top.score ? current : top))
  const legalKeys = new Set(legalAnalyses.map(analysis => tileKey(analysis.tile)))
  const correctKeys = new Set(
    legalAnalyses
      .filter(analysis => analysis.opportunityTotal === best.opportunityTotal
        && analysis.brokeCombos.length <= best.brokeCombos.length)
      .map(analysis => tileKey(analysis.tile)),
  )

  return { hand, dingque, analyses, best, legalKeys, correctKeys }
}

// ---------------------------------------------------------------------------
// 题目生成：构造"一进听"14 张手牌（摸牌后场景）
// 3 面子 + 将对 + 搭子 + 1 张浮牌：打掉浮牌即听牌，打结构牌则机会数骤降，
// 让每张候选牌都有理论区分度（M3 训练题思路：出"打哪张机会数最大"题）。
// ---------------------------------------------------------------------------

function generateDeck(): Tile[] {
  const deck: Tile[] = []
  for (const type of VALID_TYPES) {
    for (let value = 1; value <= 9; value++) {
      for (let count = 0; count < 4; count++)
        deck.push({ type, value })
    }
  }
  return deck
}

function takeFromDeck(deck: Tile[], type: TileType, value: number): boolean {
  const index = deck.findIndex(tile => tile.type === type && tile.value === value)
  if (index === -1)
    return false
  deck.splice(index, 1)
  return true
}

function drawRandom(deck: Tile[]): Tile | null {
  if (deck.length === 0)
    return null
  return deck.splice(Math.floor(Math.random() * deck.length), 1)[0]
}

function randType(types: readonly TileType[] = VALID_TYPES): TileType {
  return types[Math.floor(Math.random() * types.length)]
}

function randValue(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function tryBuildOneAwayHand(): { hand: Tile[], dingque: TileType } | null {
  const deck = generateDeck()
  const hand: Tile[] = []
  const dingque = randType()
  const availableTypes = VALID_TYPES.filter(type => type !== dingque)

  // 出牌练习默认已经完成定缺：手牌只在剩余两门内构造，直接比较牌效。
  // 3 个面子（顺子为主，偶尔刻子）
  for (let meld = 0; meld < 3; meld++) {
    if (Math.random() < 0.8) {
      const type = randType(availableTypes)
      const value = randValue(1, 7)
      if (!(takeFromDeck(deck, type, value) && takeFromDeck(deck, type, value + 1) && takeFromDeck(deck, type, value + 2)))
        return null
      hand.push({ type, value }, { type, value: value + 1 }, { type, value: value + 2 })
    }
    else {
      const type = randType(availableTypes)
      const value = randValue(1, 9)
      if (!(takeFromDeck(deck, type, value) && takeFromDeck(deck, type, value) && takeFromDeck(deck, type, value)))
        return null
      hand.push({ type, value }, { type, value }, { type, value })
    }
  }

  // 将对
  const pairType = randType(availableTypes)
  const pairValue = randValue(1, 9)
  if (!(takeFromDeck(deck, pairType, pairValue) && takeFromDeck(deck, pairType, pairValue)))
    return null
  hand.push({ type: pairType, value: pairValue }, { type: pairType, value: pairValue })

  // 搭子（两面搭）
  const runType = randType(availableTypes)
  const runValue = randValue(1, 8)
  if (!(takeFromDeck(deck, runType, runValue) && takeFromDeck(deck, runType, runValue + 1)))
    return null
  hand.push({ type: runType, value: runValue }, { type: runType, value: runValue + 1 })

  // 浮牌：70% 取搭子附近的牌制造取舍纠结，30% 纯随机
  let floatTile: Tile | null = null
  if (Math.random() < 0.7) {
    const nearby = [runValue - 2, runValue - 1, runValue + 2, runValue + 3].filter(value => value >= 1 && value <= 9)
    while (nearby.length > 0 && !floatTile) {
      const index = Math.floor(Math.random() * nearby.length)
      const value = nearby.splice(index, 1)[0]
      if (takeFromDeck(deck, runType, value))
        floatTile = { type: runType, value }
    }
  }
  if (!floatTile) {
    const type = randType(availableTypes)
    const index = deck.findIndex(tile => tile.type === type)
    if (index >= 0)
      floatTile = deck.splice(index, 1)[0]
  }
  if (!floatTile)
    return null
  hand.push(floatTile)

  return { hand, dingque }
}

function generateHand(): HandState {
  // 出牌练习默认已经打缺，题目只使用两门牌，直接训练清缺后的机会数、金线与搭子取舍。
  for (let attempt = 0; attempt < 60; attempt++) {
    const built = tryBuildOneAwayHand()
    if (!built)
      continue
    const state = analyzeHand(built.hand, built.dingque)
    if (state.best.opportunityTotal >= 4 && state.legalKeys.size > 0)
      return state
  }
  const dingque = randType()
  const availableTypes = VALID_TYPES.filter(type => type !== dingque)
  const deck = generateDeck().filter(tile => tile.type !== dingque)
  const hand: Tile[] = []
  for (let i = 0; i < 14; i++) {
    const tile = drawRandom(deck)
    if (tile)
      hand.push(tile)
  }
  return analyzeHand(hand, availableTypes[0])
}

export function DiscardMode({ onComplete }: DiscardModeProps) {
  const [gameState, setGameState] = useState<HandState>(() => generateHand())
  const [selectedTile, setSelectedTile] = useState<Tile | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [isSortedHandTile, setIsSortedHandTile] = useState(false)
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [round, setRound] = useState(1)
  const [timeLeft, setTimeLeft] = useState(30)
  const [isRunning, setIsRunning] = useState(true)
  const maxRounds = 10
  const onCompleteRef = useRef(onComplete)
  const scoreRef = useRef(score)

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    scoreRef.current = score
  }, [score])

  useEffect(() => {
    if (!isRunning || showResult)
      return

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          setIsRunning(false)
          onCompleteRef.current(scoreRef.current, 30)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [isRunning, showResult])

  const displayHand = useMemo(() => {
    return isSortedHandTile
      ? sortTilesByMahjongOrder(gameState.hand)
      : gameState.hand
  }, [gameState.hand, isSortedHandTile])

  const handleSelectTile = (tile: Tile) => {
    if (showResult || !isRunning)
      return
    setSelectedTile(tile)
  }

  const selectedAnalysis = useMemo(() => {
    if (!selectedTile)
      return null
    return gameState.analyses.find(analysis => sameTile(analysis.tile, selectedTile)) ?? null
  }, [selectedTile, gameState])

  const selectedTileIsLegal = selectedTile
    ? gameState.legalKeys.has(tileKey(selectedTile))
    : false
  const selectedTileIsCorrect = selectedTile
    ? gameState.correctKeys.has(tileKey(selectedTile))
    : false
  const dingqueRemaining = gameState.hand.filter(tile => tile.type === gameState.dingque).length
  const mustClearDingque = dingqueRemaining > 0

  /** 机会数对比列表：Top 4，用户选择不在其中则追加 */
  const comparison = useMemo(() => {
    if (!showResult)
      return []
    const sorted = [...gameState.analyses].sort((a, b) => b.opportunityTotal - a.opportunityTotal || b.score - a.score)
    const top = sorted.slice(0, 4)
    if (selectedTile && !top.some(analysis => sameTile(analysis.tile, selectedTile))) {
      const selected = sorted.find(analysis => sameTile(analysis.tile, selectedTile))
      if (selected)
        top.push(selected)
    }
    return top
  }, [showResult, gameState, selectedTile])

  const maxComparisonOpportunity = useMemo(() => {
    return Math.max(1, ...comparison.map(analysis => analysis.opportunityTotal))
  }, [comparison])

  const handleConfirm = () => {
    if (!selectedTile || !isRunning)
      return

    setIsRunning(false)
    setShowResult(true)

    if (selectedTileIsCorrect) {
      const timeBonus = Math.floor(timeLeft / 3)
      const streakBonus = streak * 20
      setScore(prev => prev + 100 + timeBonus + streakBonus)
      setStreak(prev => prev + 1)
    }
    else {
      setStreak(0)
      setScore(prev => Math.max(0, prev - 30))
    }
    trackAnswer('discard', selectedTileIsCorrect, 'opportunity_theory')
  }

  const handleNextHand = () => {
    if (round < maxRounds) {
      setRound(prev => prev + 1)
      setGameState(generateHand())
      setSelectedTile(null)
      setShowResult(false)
      setTimeLeft(30)
      setIsRunning(true)
      setIsSortedHandTile(false)
      return
    }

    onCompleteRef.current(scoreRef.current, 30 - timeLeft)
  }

  const actionLabel = showResult
    ? round < maxRounds ? '下一把' : '完成练习'
    : '确认出牌'
  const canUseActionButton = showResult || !!selectedTile
  const handleAction = () => {
    if (showResult) {
      handleNextHand()
      return
    }

    handleConfirm()
  }

  const bestTile = gameState.best.tile
  const opportunityGap = selectedAnalysis && !selectedTileIsCorrect
    ? gameState.best.opportunityTotal - selectedAnalysis.opportunityTotal
    : 0

  return (
    <div className="glass-card p-6">
      {/* 积分和进度 */}
      <div className="flex justify-between items-center mb-4 p-3 bg-black/20 rounded-xl">
        <div className="text-center">
          <div className="text-sm text-gray-400">当前积分</div>
          <div className="text-2xl font-bold text-yellow-400">{score}</div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-400">连击</div>
          <div className="text-2xl font-bold text-orange-400">
            {streak > 0 ? `${streak}x` : '-'}
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-400">倒计时</div>
          <div className={`text-2xl font-bold ${timeLeft <= 10 ? 'text-red-400' : 'text-cyan-400'}`}>
            {timeLeft}
            s
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-400">本局</div>
          <div className="text-2xl font-bold text-cyan-400">
            {round}
            /
            {maxRounds}
          </div>
        </div>
      </div>

      {/* 提示信息 */}
      <div className="text-center mb-6">
        <motion.div
          className="inline-block px-6 py-3 bg-gradient-to-r from-purple-500/20 to-pink-500/20 rounded-xl border border-purple-500/30"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="text-purple-300">已打缺：本题缺 {gameState.dingque}，手牌仅保留两门。现在比较机会数、金线和搭子结构，选出更宽的进张路线。</span>
        </motion.div>
      </div>

      {/* 手牌显示 */}
      <div className="mb-8">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-lg font-bold text-white">你的手牌</h3>
          <SortButton
            isSorted={isSortedHandTile}
            onClick={() => setIsSortedHandTile(prev => !prev)}
          />
        </div>
        <motion.div
          className="flex flex-wrap justify-center gap-2 p-4 bg-black/20 rounded-xl"
          layout
        >
          {displayHand.map((tile, index) => (
            <AnimatedMajiangTile
              key={`discard-${tile.type}${tile.value}-${index}`}
              tile={tile}
              index={index}
              keyPrefix="discard-"
              selected={selectedTile?.type === tile.type && selectedTile?.value === tile.value}
              correct={showResult && gameState.correctKeys.has(tileKey(tile))}
              error={showResult && selectedTile?.type === tile.type && selectedTile?.value === tile.value
                && !gameState.correctKeys.has(tileKey(tile))}
              onClick={() => handleSelectTile(tile)}
            />
          ))}
        </motion.div>
      </div>

      {/* 理论驱动的推荐分析 */}
      {showResult && (
        <motion.div
          className="mb-6 p-4 rounded-xl border border-cyan-400/20 bg-cyan-500/10"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {mustClearDingque && (
            <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
              <strong>定缺优先：</strong>
              你定缺 {gameState.dingque}，本手仍有 {dingqueRemaining} 张 {gameState.dingque} 未清。此时先打缺门不是“牌效差”，而是川麻的合法优先级；若终局仍持缺门，会构成花猪。
            </div>
          )}
          {/* 推荐头 */}
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <MajiangTile
              tile={bestTile}
              correct
              small
            />
            <div className="min-w-0 flex-1">
              <div className="text-cyan-200 font-semibold">
                推荐打出：
                {formatTile(bestTile)}
              </div>
              <div className="mt-0.5 text-xs text-cyan-100/70">
                机会数
                {' '}
                {gameState.best.opportunityTotal}
                {' '}
                张（评级：
                {OPP_RATING_LABEL[rateOpportunity(gameState.best.opportunityTotal)]}
                ）·
                {' '}
                {WAIT_SHAPE_LABEL[gameState.best.waitShape]}
              </div>
            </div>
          </div>

          {/* 理论分析列表 */}
          <div className="space-y-1.5 mb-3">
            {gameState.best.reasons.map(reason => (
              <div key={reason} className="text-sm text-cyan-100/85 leading-relaxed">
                •
                {reason}
              </div>
            ))}
            <div className="pt-1 text-xs text-amber-200/70">
              📖 理论依据：朱扬《麻将"机会数"理论与实战》——"机会数是取舍的准绳，没有它就很难判断这手牌的取舍"
            </div>
          </div>

          {/* 机会数对比 */}
          {comparison.length > 1 && (
            <div className="pt-3 border-t border-cyan-400/15">
              <div className="text-sm text-cyan-200 font-semibold mb-2">
                机会数对比（打出后剩余有效进张）
              </div>
              {comparison.map((analysis) => {
                const isBest = analysis.opportunityTotal === gameState.best.opportunityTotal
                  && analysis.brokeCombos.length <= gameState.best.brokeCombos.length
                const isSelected = selectedTile && sameTile(analysis.tile, selectedTile)
                const width = Math.round(analysis.opportunityTotal / maxComparisonOpportunity * 100)
                return (
                  <div key={tileKey(analysis.tile)} className="flex items-center gap-2 mb-1.5">
                    <span className={`w-12 text-xs shrink-0 ${isBest ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
                      {formatTile(analysis.tile)}
                      {isSelected ? ' ←你' : ''}
                    </span>
                    <div className="flex-1 h-4 bg-black/30 rounded overflow-hidden">
                      <div
                        className={`h-4 rounded transition-all ${isBest ? 'bg-green-500/70' : isSelected ? 'bg-red-500/60' : 'bg-cyan-500/40'}`}
                        style={{ width: `${Math.max(width, analysis.opportunityTotal > 0 ? 6 : 0)}%` }}
                      />
                    </div>
                    <span className="w-36 text-xs text-gray-300 shrink-0">
                      {analysis.opportunityTotal}
                      {' '}
                      张 ·
                      {' '}
                      {WAIT_SHAPE_LABEL[analysis.waitShape]}
                      {analysis.brokeCombos.length > 0 ? ' · 拆强组合' : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* 你的选择点评 */}
          {selectedTile && !selectedTileIsCorrect && selectedAnalysis && (
            <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-400/20">
              <div className="text-sm text-red-300 leading-relaxed">
                {!selectedTileIsLegal
                  ? `你选的 ${formatTile(selectedAnalysis.tile)} 不属于当前允许的出牌：定缺 ${gameState.dingque} 还没清完，必须先打缺门，否则终局会保留花猪风险。`
                  : <>你选的 {formatTile(selectedAnalysis.tile)}：机会数 {selectedAnalysis.opportunityTotal} 张{selectedAnalysis.brokeCombos.length > 0 && `，且拆散了强组合 ${selectedAnalysis.brokeCombos.map(([a, b]) => `${a}-${b}`).join('、')}`}{opportunityGap > 0 && `——比最佳选择少 ${opportunityGap} 张有效进张`}{opportunityGap === 0 && selectedAnalysis.brokeCombos.length > 0 && '——机会数虽持平，但拆强组合是复盘重罚项'}</>}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* 结果提示 */}
      {showResult && (
        <motion.div
          className={`text-center p-4 rounded-xl mb-4 ${
            selectedTileIsCorrect
              ? 'bg-green-500/20 border border-green-500/30'
              : 'bg-red-500/20 border border-red-500/30'
          }`}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          {selectedTileIsCorrect
            ? (
                <div className="text-green-400 font-bold">
                  <span className="text-2xl mr-2">✓</span>
                  正确！数着进张打牌——这就是机会数决策
                </div>
              )
            : (
                <div className="text-red-400 font-bold">
                  <span className="text-2xl mr-2">✗</span>
                  最佳出牌是
                  {' '}
                  {formatTile(bestTile)}
                  <div className="text-sm font-normal mt-1 text-gray-400">
                    打
                    {formatTile(bestTile)}
                    后机会数最大（
                    {gameState.best.opportunityTotal}
                    {' '}
                    张），详见上方理论分析
                  </div>
                </div>
              )}
        </motion.div>
      )}

      {/* 操作按钮 */}
      <motion.button
        className={`neon-button w-full ${canUseActionButton ? 'neon-button-success' : 'opacity-50 cursor-not-allowed'}`}
        onClick={handleAction}
        disabled={!canUseActionButton}
        whileHover={canUseActionButton ? { scale: 1.02 } : {}}
        whileTap={canUseActionButton ? { scale: 0.98 } : {}}
      >
        {actionLabel}
      </motion.button>
    </div>
  )
}
