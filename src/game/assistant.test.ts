import type { TileType } from '../types'
import type { GameState, TileInstance } from './types'
import { describe, expect, it } from 'vitest'
import { buildCandidateLesson, buildDiscardAssistant, buildHuLesson, buildImmediateDiscardFeedback, buildPengLesson, countKnownCopies } from './assistant'
import { createInitialGame, createTileSet, sortTiles } from './core'

function take(pool: TileInstance[], specification: string): TileInstance[] {
  return specification.trim().split(/\s+/).flatMap((part) => {
    const type = part[part.length - 1] as TileType
    return [...part.slice(0, -1)].map((character) => {
      const index = pool.findIndex(tile => tile.type === type && tile.value === Number(character))
      if (index < 0)
        throw new Error(`夹具缺少 ${character}${type}`)
      return pool.splice(index, 1)[0]
    })
  })
}

function fixture(): GameState {
  const pool = createTileSet()
  const state = createInitialGame(1)
  state.phase = 'discarding'
  state.currentPlayer = 0
  state.players[0].hand = sortTiles(take(pool, '123456789万 55万 34条 4条'))
  state.players[0].dingque = '筒'
  for (const player of state.players.slice(1)) {
    player.hand = []
    player.discards = []
    player.melds = []
    player.dingque = player.id === 1 ? '万' : '条'
  }
  state.wall = pool
  return state
}

describe('实时出牌助手', () => {
  it('推荐合法出牌并按全部未知牌计算下一张胡牌概率', () => {
    const state = fixture()
    const analysis = buildDiscardAssistant(state)
    expect(analysis.recommendation).toMatchObject({ type: 'discard', playerId: 0 })
    expect(analysis.recommendationLabel).toBe('打 4条')
    expect(analysis.opportunity).toBe(8)
    expect(analysis.waits.map(wait => `${wait.tile.value}${wait.tile.type}`)).toEqual(['2条', '5条'])
    expect(analysis.reason).toContain('机会质量良好')
    expect(analysis.knownTiles).toBe(14)
    expect(analysis.unknownTiles).toBe(94)
    expect(analysis.nextDrawWinProbability).toBeCloseTo(8 / 94)
    expect(analysis.candidates[0]).toMatchObject({
      tile: { type: '条', value: 4 },
      isRecommended: true,
      opportunity: 8,
      structuralWaits: 2,
    })
    expect(analysis.candidates[0].waits.map(wait => `${wait.tile.value}${wait.tile.type}`)).toEqual(['2条', '5条'])
  })

  it('对手暗牌不计入已知牌，公开牌计入并扣减叫口', () => {
    const state = fixture()
    state.players[1].hand = take(state.wall, '23456789筒 12345条')
    const hidden = buildDiscardAssistant(state)
    expect(hidden.knownTiles).toBe(14)

    const visibleFive = take(state.wall, '5条')[0]
    state.players[1].discards.push(visibleFive)
    const revealed = buildDiscardAssistant(state)
    expect(revealed.knownTiles).toBe(15)
    expect(revealed.opportunity).toBe(7)
    expect(countKnownCopies(revealed, { type: '条', value: 5 })).toBe(1)
  })

  it('胡牌后亮出的手牌计入已知牌，未胡玩家的暗牌仍然保密', () => {
    const state = fixture()
    state.players[1].hand = take(state.wall, '123456789筒 1234条')
    state.players[2].hand = take(state.wall, '23456789万 678条 11筒')
    state.players[1].hasWon = true

    const analysis = buildDiscardAssistant(state)
    expect(analysis.knownTiles).toBe(27)
    expect(analysis.unknownTiles).toBe(81)
    expect(countKnownCopies(analysis, { type: '筒', value: 9 })).toBe(1)
    expect(countKnownCopies(analysis, { type: '条', value: 6 })).toBe(0)
  })

  it('定缺阶段只给定缺建议，不伪造胡牌概率', () => {
    const state = createInitialGame(42)
    const analysis = buildDiscardAssistant(state)
    expect(analysis.recommendation?.type).toBe('dingque')
    expect(analysis.nextDrawWinProbability).toBeNull()
  })

  it('未下叫时为每种弃牌给出下一摸入听进张与概率，而不是空定义', () => {
    const state = fixture()
    state.players[0].hand = sortTiles(take(state.wall, '123456789万 34567条'))
    const analysis = buildDiscardAssistant(state)
    const unready = analysis.candidates.find(candidate => candidate.nextDrawWinProbability === null)
    expect(unready).toBeDefined()
    expect(unready?.tenpaiPaths.length).toBeGreaterThan(0)
    expect(unready?.nextDrawTenpaiProbability).not.toBeNull()
    expect(unready?.tenpaiPaths.reduce((sum, path) => sum + path.remaining, 0)).toBeGreaterThan(0)
  })

  it('只在实际弃牌明显走窄时给出即时路线反馈', () => {
    const analysis = buildDiscardAssistant(fixture())
    const best = analysis.candidates[0]
    const inferior = analysis.candidates.find(candidate => candidate.opportunity <= best.opportunity - 3)
    expect(inferior).toBeDefined()
    expect(buildImmediateDiscardFeedback(analysis, inferior!.tile)).toMatchObject({
      kind: 'route',
      message: expect.stringContaining('少留'),
    })
    expect(buildImmediateDiscardFeedback(analysis, best.tile)).toBeNull()
  })

  it('每巡先给出明确局势目标，并用它约束候选讲解', () => {
    const ready = buildDiscardAssistant(fixture())
    expect(ready.coach.objective).toBe('convert')
    expect(ready.coach.headline).toContain('本巡目标：尽快兑现')

    const dangerState = fixture()
    dangerState.players[1].dingque = '万'
    dangerState.players[1].discards = take(dangerState.wall, '1万')
    dangerState.players[1].melds = [{ kind: 'peng', tiles: take(dangerState.wall, '555条'), fromPlayer: 2 }, { kind: 'peng', tiles: take(dangerState.wall, '666条'), fromPlayer: 3 }]
    const danger = buildDiscardAssistant(dangerState)
    expect(danger.coach.objective).toBe('defend')
    expect(danger.coach.headline).toContain('本巡目标：先防守')
    expect(buildCandidateLesson(danger, danger.candidates[0]).explanation).toContain('本巡目标是先防守')
  })

  it('点选候选时给出可核对的手把手教学结论', () => {
    const analysis = buildDiscardAssistant(fixture())
    const best = analysis.candidates[0]
    const alternative = analysis.candidates.find(candidate => !candidate.isRecommended)!
    const bestLesson = buildCandidateLesson(analysis, best)
    const alternativeLesson = buildCandidateLesson(analysis, alternative)

    expect(bestLesson).toMatchObject({ verdict: 'recommended', headline: expect.stringContaining('最优解') })
    expect(bestLesson.evidence).toContain(`候选排序第 1 / ${analysis.candidates.length}`)
    expect(alternativeLesson).toMatchObject({ headline: expect.stringContaining(`打 ${alternative.tile.value}${alternative.tile.type}`) })
    expect(alternativeLesson.evidence.some(item => item.startsWith('推荐方案：打 '))).toBe(true)
  })

  it('保留理论叫口，并将公开打光的叫口标注为理论死听', () => {
    const state = fixture()
    state.players[1].discards = take(state.wall, '2222条')
    const analysis = buildDiscardAssistant(state)
    const candidate = analysis.candidates.find(item => item.tile.type === '条' && item.tile.value === 4)!
    const lesson = buildCandidateLesson(analysis, candidate)

    expect(candidate.theoreticalWaits.map(wait => `${wait.tile.value}${wait.tile.type}`)).toEqual(['2条', '5条'])
    expect(candidate.waits.map(wait => `${wait.tile.value}${wait.tile.type}`)).toEqual(['5条'])
    expect(candidate.theoreticalWaits.find(wait => wait.tile.type === '条' && wait.tile.value === 2)?.remaining).toBe(0)
    expect(lesson.explanation).toContain('2条（理论死听·0张）')
    expect(lesson.evidence).toContain('2条 已打光 · 理论死听')
  })

  it('弃牌首选与候选排序使用同一套价值模型，不再依赖另一套 AI 结构评分', () => {
    const analysis = buildDiscardAssistant(fixture())
    expect(analysis.recommendationLabel).toBe(`打 ${analysis.candidates[0].tile.value}${analysis.candidates[0].tile.type}`)
    expect(analysis.candidates[0].isRecommended).toBe(true)
    expect(analysis.candidates.slice(1).every(candidate => !candidate.isRecommended)).toBe(true)
  })

  it('每个非首选候选仍保留独立的做牌趋势与讲解证据', () => {
    const state = fixture()
    state.players[0].hand = sortTiles(take(state.wall, '1122334455667条'))
    state.players[0].dingque = '万'
    const analysis = buildDiscardAssistant(state)
    const alternative = analysis.candidates.find(candidate => !candidate.isRecommended)!
    const lesson = buildCandidateLesson(analysis, alternative)

    expect(alternative.patternTrends.some(trend => trend.pattern === 'qingyise')).toBe(true)
    expect(lesson.explanation).toContain('清一色')
    expect(lesson.evidence.some(item => item.includes('清一色'))).toBe(true)
    expect(lesson.evidence.some(item => item.includes('做牌') || item.includes('危险门'))).toBe(true)
    expect(Number.isFinite(alternative.trendAdjustment)).toBe(true)
  })

  it('有胡牌机会时给出立即兑现与继续追价值的可核验取舍', () => {
    const state = fixture()
    state.phase = 'responding'
    state.wall.push(...state.players[0].hand)
    const called = take(state.wall, '4条')[0]
    state.players[0].hand = sortTiles(take(state.wall, '123456789万 55万 35条'))
    state.responseWindow = {
      kind: 'discard', sourcePlayer: 1, tile: called, eligiblePlayers: [0], choices: {}, resumePlayer: 1,
      pendingMeldIndex: null, sourceEventSequence: 1, isLastTile: false, isKongDiscard: false,
    }
    const analysis = buildDiscardAssistant(state)
    const lesson = buildHuLesson(analysis)

    expect(analysis.huDecision).toMatchObject({ points: expect.any(Number), wallTiles: expect.any(Number) })
    expect(lesson?.evidence.some(item => item.startsWith('立即胡：'))).toBe(true)
    expect(lesson?.evidence.some(item => item.startsWith('继续后当前可核验机会数：'))).toBe(true)
  })

  it('出现碰牌时，比较不碰与碰后最佳弃张的机会数', () => {
    const state = fixture()
    state.phase = 'responding'
    state.currentPlayer = 1
    const called = take(state.wall, '5万')[0]
    state.players[0].dingque = '筒'
    state.responseWindow = {
      kind: 'discard', sourcePlayer: 1, tile: called, eligiblePlayers: [0], choices: {}, resumePlayer: 1,
      pendingMeldIndex: null, sourceEventSequence: 1, isLastTile: false, isKongDiscard: false,
    }
    const analysis = buildDiscardAssistant(state)
    const lesson = buildPengLesson(analysis)

    expect(analysis.pengCandidate).toMatchObject({ tile: { type: '万', value: 5 }, forcedDiscardCount: expect.any(Number) })
    expect(analysis.pengCandidate?.bestDiscard).not.toBeNull()
    expect(lesson?.headline).toContain('碰 5万')
    expect(lesson?.evidence.some(item => item.startsWith('不碰：当前机会数'))).toBe(true)
  })
})
