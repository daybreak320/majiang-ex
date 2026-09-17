import type { GameState, PlayerId, TileInstance } from '../game/types'
import type { TileType } from '../types'
import type { DecisionTheme } from './xiaoshiTypes'
// 破晓哥镜像导师 · 规则判定通道单测
import { describe, expect, it } from 'vitest'
import { chooseAICommand } from '../game/ai'
import { createInitialGame, createTileSet } from '../game/core'
import { executeCommand } from '../game/engine'
import {
  buildXiaoshiAdvice,
  DROP_CALL_MAX_LIVE_WAITS,
  makeQuoteBridge,
  matchUserAngles,
  MAX_DECISION_ADVICE,
  MAX_OBSERVE_ADVICE,
  relativeDistance,
  seatLabelOf,
} from './xiaoshiAdvisor'
import { getXiaoshiRule } from './xiaoshiRules'

/** 从标准牌池按「1万 2条 3筒」描述取牌 */
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

/** 建一局干净局面：四家清空，可继续放牌 */
function emptyGame(seed: number): { state: GameState, pool: TileInstance[] } {
  const pool = createTileSet()
  const state = createInitialGame(seed)
  state.phase = 'discarding'
  state.responseWindow = null
  for (const player of state.players) {
    player.hand = []
    player.discards = []
    player.melds = []
    player.dingque = '筒'
    player.hasWon = false
  }
  state.wall = pool
  return { state, pool }
}

describe('座次映射', () => {
  it('以行动流为序：+1 为下家、+2 为对家、+3 为上家', () => {
    expect(seatLabelOf(0, 0)).toBe('自己')
    expect(seatLabelOf(0, 1)).toBe('下家')
    expect(seatLabelOf(0, 2)).toBe('对家')
    expect(seatLabelOf(0, 3)).toBe('上家')
    expect(seatLabelOf(2, 3)).toBe('下家')
    expect(seatLabelOf(2, 0)).toBe('对家')
    expect(seatLabelOf(2, 1)).toBe('上家')
    expect(relativeDistance(0, 1)).toBe(1)
    expect(relativeDistance(0, 3)).toBe(3)
  })
})

describe('R-RIVER-INFER-v0：对手弃 7 与 9 反推高张', () => {
  it('下家弃过 7筒、9筒 → 命中，提示高张顺子大概率不在其手', () => {
    const { state, pool } = emptyGame(801)
    const discardTiles = take(pool, '7筒 9筒 1万')
    state.players[1].discards = discardTiles
    state.players[1].dingque = '条' // 筒不是其定缺 → 打 7/9 筒才含结构信息
    state.players[3].discards = take(pool, '2万')
    state.players[0].hand = take(pool, '8筒 9筒') // 自己手上有筒 → 提示才落地

    const advice = buildXiaoshiAdvice(state, 0)
    const hit = advice.find(item => item.ruleId === 'R-RIVER-INFER-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('下家')
    expect(hit!.headline).toContain('筒')
    expect(hit!.quote.length).toBeGreaterThan(0)
    expect(hit!.confidence).toBeGreaterThan(0)
    expect(hit!.boundary).toContain('非常规')
  })

  it('对家弃过 7条、9条 → 命中并指认对家', () => {
    const { state, pool } = emptyGame(802)
    state.players[2].discards = take(pool, '7条 9条')
    state.players[2].dingque = '筒'
    state.players[0].hand = take(pool, '8条')
    const advice = buildXiaoshiAdvice(state, 0)
    const hit = advice.find(item => item.ruleId === 'R-RIVER-INFER-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('对家')
  })

  it('对手打的是自己的定缺门 → 属于例行打缺，静默', () => {
    const { state, pool } = emptyGame(804)
    state.players[1].dingque = '筒' // 筒是其定缺，打 7/9 筒只是打缺
    state.players[1].discards = take(pool, '7筒 9筒')
    state.players[0].hand = take(pool, '8筒')
    expect(buildXiaoshiAdvice(state, 0).find(a => a.ruleId === 'R-RIVER-INFER-v0')).toBeUndefined()
  })

  it('无人同门弃 7+9 → 不触发（保持安静）', () => {
    const { state, pool } = emptyGame(803)
    state.players[1].discards = take(pool, '7筒 8筒 9万') // 有 7 无 9（不同门）
    state.players[2].discards = take(pool, '9筒 6筒') // 有 9 无 7
    const advice = buildXiaoshiAdvice(state, 0)
    expect(advice.find(item => item.ruleId === 'R-RIVER-INFER-v0')).toBeUndefined()
  })
})

/**
 * 布局：玩家0 手牌 6条对 + 三面子 + 单钓 5条 与 单张 9条（共 13 张，无副露）。
 * 下家打出 6条 → 可碰。碰后（meld=1，手 11 张）必须弃 1 张：
 *   - 弃 9条 → 10 张 = 123万 234万 456条 + 5条单钓 → 听 5条（河里已见 2 张 → 活张 1）
 *   - 弃 5条 → 10 张 = 123万 234万 456条 + 9条单钓 → 听 9条（河里已见 2 张 → 活张 1）
 * 两种弃法活张都 ≤ 阈值 → 触发「下叫也是给自己看」。
 */
function buildDropCallGame(seed: number): GameState {
  const { state, pool } = emptyGame(seed)
  const t = (spec: string) => take(pool, spec)
  state.players[0].hand = t('6条 6条 1万 2万 3万 2万 3万 4万 4条 5条 6条 5条 9条')
  state.players[0].dingque = '筒'
  // 下家弃 6条，触发响应窗；另在两家牌河放 2 张 5条、2 张 9条 制造死叫
  state.players[1].discards = t('6条 5条 9条')
  state.players[2].discards = t('5条 9条')
  state.phase = 'responding'
  state.responseWindow = {
    kind: 'discard',
    sourcePlayer: 1,
    tile: state.players[1].discards[0],
    eligiblePlayers: [0],
    choices: { 0: { type: 'peng' } },
    resumePlayer: 1,
    pendingMeldIndex: null,
    sourceEventSequence: 1,
    isLastTile: false,
    isKongDiscard: false,
  }
  return state
}

describe('R-DROP-CALL-v0：碰牌下叫前先算叫的存活率', () => {
  it('可碰即下叫但活张很薄 → 命中，建议别急着碰', () => {
    const state = buildDropCallGame(811)
    const advice = buildXiaoshiAdvice(state, 0)
    const hit = advice.find(item => item.ruleId === 'R-DROP-CALL-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('碰6条')
    expect(hit!.headline).toContain('给自己看')
    expect(hit!.evidence[0]).toContain('下家打出 6条')
    expect(hit!.quote).toContain('暂时不要叫')
    expect(hit!.confidence).toBeLessThanOrEqual(0.85)
  })

  it('无响应窗口 → 不触发', () => {
    const { state, pool } = emptyGame(812)
    state.players[0].hand = take(pool, '6条 6条 1万 2万 3万 2万 3万 4万 4条 5条 6条 5条 9条')
    const advice = buildXiaoshiAdvice(state, 0)
    expect(advice.find(item => item.ruleId === 'R-DROP-CALL-v0')).toBeUndefined()
  })

  it('活张阈值导出可见且规则用其判定', () => {
    expect(DROP_CALL_MAX_LIVE_WAITS).toBeLessThanOrEqual(3)
  })
})

describe('buildXiaoshiAdvice 主入口', () => {
  it('无事发生 → 不产生「需要立刻动作」的建议（响应/出牌类保持安静）', () => {
    const { state, pool } = emptyGame(821)
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 4条')
    state.players[0].dingque = '筒'
    const advice = buildXiaoshiAdvice(state, 0)
    // 没有响应窗口、也没有待出的关键抉择 → 不打扰玩家出牌
    expect(advice.filter(a => a.windowKind === 'response')).toEqual([])
    expect(advice.filter(a => a.windowKind === 'discard')).toEqual([])
  })

  it('决策类与观察类分开限流', () => {
    const state = buildDropCallGame(822)
    const all = buildXiaoshiAdvice(state, 0, { maxDecision: 20, maxObserve: 20 })
    const decision = all.filter(a => a.windowKind !== 'any')
    const observe = all.filter(a => a.windowKind === 'any')
    // 放开上限时两类都能出
    expect(all.length).toBe(decision.length + observe.length)
    // 默认调用下：决策类 ≤ MAX_DECISION_ADVICE，观察类 ≤ MAX_OBSERVE_ADVICE
    const dflt = buildXiaoshiAdvice(state, 0)
    expect(dflt.filter(a => a.windowKind !== 'any').length).toBeLessThanOrEqual(MAX_DECISION_ADVICE)
    expect(dflt.filter(a => a.windowKind === 'any').length).toBeLessThanOrEqual(MAX_OBSERVE_ADVICE)
    // 响应窗口下 DROP-CALL 必在其中
    expect(dflt.some(item => item.ruleId === 'R-DROP-CALL-v0')).toBe(true)
  })

  it('限流：置信度高的排前面', () => {
    const state = buildDropCallGame(823)
    const all = buildXiaoshiAdvice(state, 0, { maxDecision: 20, maxObserve: 20 })
    if (all.length > 1) {
      expect(all[0]!.confidence).toBeGreaterThanOrEqual(all[all.length - 1]!.confidence)
    }
  })
})

// ---------------------------------------------------------------------------
// I 簇：形势与信息（读牌类规则）
// ---------------------------------------------------------------------------

/** 全部命中（不截断），便于逐条断言 */
function allAdvice(state: GameState, self: 0 | 1 | 2 | 3 = 0) {
  return buildXiaoshiAdvice(state, self, { maxDecision: 20, maxObserve: 20 })
}

describe('R-REBUILD-HAND-FROM-MELDS-v0：用副露+弃牌时序重建对手手牌', () => {
  it('下家两副筒子副露 → 推断其手牌主门', () => {
    const { state, pool } = emptyGame(901)
    // 下家：定缺条，碰出两副筒子；万门弃过 2 张（→ 不满足「几乎不弃」，避免被 READ-BIG-DANDIAO 抑制）
    state.players[1].dingque = '条'
    state.players[1].melds = [
      { kind: 'peng', tiles: take(pool, '3筒 3筒 3筒'), fromPlayer: 2 },
      { kind: 'peng', tiles: take(pool, '8筒 8筒 8筒'), fromPlayer: 3 },
    ]
    state.players[1].discards = take(pool, '1万 5万')
    const advice = allAdvice(state)
    const hit = advice.find(a => a.ruleId === 'R-REBUILD-HAND-FROM-MELDS-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('万')
    expect(hit!.evidence.join(' ')).toContain('筒')
  })

  it('副露不足两副 → 静默', () => {
    const { state, pool } = emptyGame(902)
    state.players[1].melds = [{ kind: 'peng', tiles: take(pool, '3筒 3筒 3筒'), fromPlayer: 2 }]
    expect(allAdvice(state).some(a => a.ruleId === 'R-REBUILD-HAND-FROM-MELDS-v0')).toBe(false)
  })
})

describe('R-READ-BIG-DANDIAO-v0：逆推对手单钓范围', () => {
  it('副露两副 + 万门几乎不弃 + 收万只有两家 → 单钓锁在万门', () => {
    const { state, pool } = emptyGame(911)
    state.players[0].dingque = '筒'
    state.players[1].dingque = '条'
    state.players[2].dingque = '万'
    state.players[3].dingque = '万'
    state.players[1].melds = [
      { kind: 'peng', tiles: take(pool, '3筒 3筒 3筒'), fromPlayer: 2 },
      { kind: 'peng', tiles: take(pool, '8筒 8筒 8筒'), fromPlayer: 3 },
    ]
    state.players[1].discards = take(pool, '2条')
    const advice = allAdvice(state)
    const hit = advice.find(a => a.ruleId === 'R-READ-BIG-DANDIAO-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('万')
    // 更具体的单钓推断会抑制通用的「重建手牌」提示
    expect(advice.some(a => a.ruleId === 'R-REBUILD-HAND-FROM-MELDS-v0')).toBe(false)
  })

  it('三家都在收该门 → 前提不成立，静默', () => {
    const { state, pool } = emptyGame(912)
    for (const p of state.players) p.dingque = '筒' // 四家都收万
    state.players[1].melds = [
      { kind: 'peng', tiles: take(pool, '3筒 3筒 3筒'), fromPlayer: 2 },
      { kind: 'peng', tiles: take(pool, '8筒 8筒 8筒'), fromPlayer: 3 },
    ]
    expect(allAdvice(state).some(a => a.ruleId === 'R-READ-BIG-DANDIAO-v0')).toBe(false)
  })
})

describe('R-INFO-TWO-COLLECT-v0：两家收牌 + 明确信息 ≈ 单行道', () => {
  it('条门两家收、另一家已在弃条 → 视同单行道', () => {
    const { state, pool } = emptyGame(921)
    state.players[0].dingque = '筒'
    state.players[1].dingque = '筒'
    state.players[2].dingque = '条'
    state.players[3].dingque = '条'
    state.players[1].discards = take(pool, '2条 5条') // 明确反向信息：他在弃条
    state.players[0].hand = take(pool, '1条 2条 3条 4条') // 条门正是自己的主攻门
    const hit = allAdvice(state).find(a => a.ruleId === 'R-INFO-TWO-COLLECT-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('条')
    expect(hit!.evidence.join(' ')).toContain('弃 2 张条')
  })

  it('另一家没有给出反向信息 → 静默', () => {
    const { state } = emptyGame(922)
    state.players[0].dingque = '筒'
    state.players[1].dingque = '筒'
    state.players[2].dingque = '条'
    state.players[3].dingque = '条'
    expect(allAdvice(state).some(a => a.ruleId === 'R-INFO-TWO-COLLECT-v0')).toBe(false)
  })
})

describe('R-DEPTH-JUDGE-v0：深张/浅张判断哪张先出', () => {
  it('同门两叫口一深一浅 → 浅张先出', () => {
    const { state, pool } = emptyGame(931)
    // 自己听 2条/5条（2345 条型），其中 2条 已现、5条 未现
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 2条 3条 4条 5条')
    state.players[0].dingque = '筒'
    state.players[1].discards = take(pool, '2条')
    const hit = allAdvice(state).find(a => a.ruleId === 'R-DEPTH-JUDGE-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('2条')
    expect(hit!.headline).toContain('浅')
  })
})

describe('R-NOREACTION-INFO-v0：对手「无反应」也是信息', () => {
  it('对手不缺万且万门高张全未现 → 高张已成结构', () => {
    const { state, pool } = emptyGame(941)
    state.players[2].dingque = '筒'
    // 已打出 5 张（排除开局伪信号），万门一张没打，且 7/8/9 万全部未现
    state.players[2].discards = take(pool, '1条 2条 3条 4条 5条')
    const hit = allAdvice(state).find(a => a.ruleId === 'R-NOREACTION-INFO-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('万')
    expect(hit!.headline).toContain('已成结构')
  })
})

describe('R-ENUM-PROB-CHOICE-v0：读不准就枚举情形算张数', () => {
  it('两个方案存活张数相同 → 提示按概率选', () => {
    const { state, pool } = emptyGame(951)
    // 111/222/333/444/55 万：弃 1 万与弃 4 万都能听且存活数相同
    state.players[0].hand = take(pool, '1万 1万 1万 2万 2万 2万 3万 3万 3万 4万 4万 4万 5万 5万')
    state.players[0].dingque = '筒'
    const hit = allAdvice(state).find(a => a.ruleId === 'R-ENUM-PROB-CHOICE-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('按概率')
  })
})

describe('R-FUTURE-WAIT-DEAD-v0：未来的叫也要先算存活', () => {
  it('存在「能下叫但胡张已绝」的路线 → 提示排除', () => {
    const { state, pool } = emptyGame(961)
    // 9条 四张全部现完（下家碰 3 张 + 自己手里 1 张）→ 单钓 9条 是死叫；弃 9条 则单钓 5条（活）
    state.players[1].melds = [{ kind: 'peng', tiles: take(pool, '9条 9条 9条'), fromPlayer: 2 }]
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 5条 9条')
    state.players[0].dingque = '筒'
    const hit = allAdvice(state).find(a => a.ruleId === 'R-FUTURE-WAIT-DEAD-v0')
    expect(hit).toBeDefined()
    expect(hit!.evidence.join(' ')).toContain('9条')
  })
})

describe('R-INFER-BEFORE-PONG-v0：看他碰之前打过什么', () => {
  it('碰 4万 前打过 2万 → 排除 234万 组合', () => {
    const { state, pool } = emptyGame(971)
    const earlier = take(pool, '2万')[0]!
    const meldTile = take(pool, '4万')[0]!
    state.events = [
      { type: 'tile_discarded', playerId: 1, tile: earlier, sequence: 1 } as GameState['events'][number],
      {
        type: 'meld_declared',
        playerId: 1,
        meld: { kind: 'peng', tiles: [meldTile, ...take(pool, '4万 4万')], fromPlayer: 2 },
        replacedMeldIndex: null,
        sequence: 2,
      } as GameState['events'][number],
    ]
    const hit = allAdvice(state).find(a => a.ruleId === 'R-INFER-BEFORE-PONG-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('234万')
    expect(hit!.evidence.join(' ')).toContain('时序')
  })

  it('无副露事件 → 静默', () => {
    const { state } = emptyGame(972)
    expect(allAdvice(state).some(a => a.ruleId === 'R-INFER-BEFORE-PONG-v0')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D 簇：防守与逃跑
// ---------------------------------------------------------------------------

describe('R-ESCAPE-AVOID-BIG-v0：躲大牌优先于做大牌', () => {
  it('对手两副同门副露（但未清一色）→ 目标切防御', () => {
    const { state, pool } = emptyGame(981)
    state.players[2].melds = [
      { kind: 'peng', tiles: take(pool, '3万 3万 3万'), fromPlayer: 1 },
      { kind: 'peng', tiles: take(pool, '7万 7万 7万'), fromPlayer: 3 },
    ]
    state.players[2].discards = take(pool, '2万 5万 9万') // 该门弃得多 → 不构成清一色
    const hit = allAdvice(state).find(a => a.ruleId === 'R-ESCAPE-AVOID-BIG-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('躲')
  })
})

describe('R-ESCAPE-SWITCH-SUIT-v0：对手做清一色 → 反向利用缺章', () => {
  it('对手两副万子副露且几乎不弃万 → 提示换门', () => {
    const { state, pool } = emptyGame(991)
    state.players[2].dingque = '筒'
    state.players[2].melds = [
      { kind: 'peng', tiles: take(pool, '3万 3万 3万'), fromPlayer: 1 },
      { kind: 'peng', tiles: take(pool, '7万 7万 7万'), fromPlayer: 3 },
    ]
    state.players[2].discards = take(pool, '2条')
    const advice = allAdvice(state)
    const hit = advice.find(a => a.ruleId === 'R-ESCAPE-SWITCH-SUIT-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('清一色')
    // 具体动作会抑制通用告警
    expect(advice.some(a => a.ruleId === 'R-ESCAPE-AVOID-BIG-v0')).toBe(false)
  })
})

describe('R-SET-BOTTOM-LINE-v0：中前期定好走/放底线', () => {
  /** 自己听 2条/5条，下家打出 5条 可胡 2 分 */
  function bottomLineGame(seed: number, wallLeft: number) {
    const { state, pool } = emptyGame(seed)
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 2条 3条 4条 5条')
    state.players[0].dingque = '筒'
    const tile = take(pool, '5条')[0]!
    state.wall = pool.slice(0, wallLeft)
    state.phase = 'responding'
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 1,
      tile,
      eligiblePlayers: [0],
      choices: { 0: { type: 'hu', value: 2 } },
      resumePlayer: 1,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    return state
  }

  it('牌墙尚多、存活张够 → 这条路要不要放，由放一手三兄弟回答', () => {
    const advice = allAdvice(bottomLineGame(1001, 40))
    const hit = advice.find(a => a.ruleId === 'R-SET-BOTTOM-LINE-v0' || a.ruleId === 'R-ZIMO-OR-NOTHING-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toMatch(/放一手|不胡/)
  })

  it('牌墙将尽 → 交给 EV 规则算放过 vs 胡', () => {
    const advice = allAdvice(bottomLineGame(1002, 4))
    const hit = advice.find(a => a.ruleId === 'R-EV-DECLINE-HU-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('EV')
    expect(hit!.evidence.some(e => e.includes('EV 对比'))).toBe(true)
  })
})

describe('真实对局冒烟：整局每一步都调用导师', () => {
  it('不抛异常、不刷屏（每步 ≤ MAX_ADVICE_PER_TURN）、建议结构完整', () => {
    let state = createInitialGame(20260907)
    let adviceCount = 0
    let steps = 0
    for (; steps < 4000 && state.phase !== 'finished'; steps++) {
      const advice = buildXiaoshiAdvice(state, 0)
      expect(advice.length).toBeLessThanOrEqual(MAX_DECISION_ADVICE + MAX_OBSERVE_ADVICE)
      for (const item of advice) {
        expect(item.headline.length).toBeGreaterThan(0)
        expect(item.advice.length).toBeGreaterThan(0)
        expect(item.quote.length).toBeGreaterThan(0)
        expect(item.evidence.length).toBeGreaterThan(0)
        expect(item.confidence).toBeGreaterThan(0)
      }
      adviceCount += advice.length

      let playerId: PlayerId | undefined
      if (state.phase === 'dingque') {
        playerId = ([0, 1, 2, 3] as PlayerId[]).find(id => state.players[id].dingque === null)
      }
      else if (state.phase === 'responding') {
        playerId = state.responseWindow?.eligiblePlayers
          .find(id => state.responseWindow?.choices[id] === undefined)
      }
      else {
        playerId = state.currentPlayer
      }
      if (playerId === undefined)
        break
      const command = chooseAICommand(state, playerId)
      if (command === null)
        break
      const result = executeCommand(state, command)
      if (!result.ok)
        break
      state = result.nextState
    }
    expect(steps).toBeGreaterThan(20)
    // 导师确实在实战局面里开过口（而不是全程静默 = 规则写死/失效）
    expect(adviceCount).toBeGreaterThan(0)
  })
})

describe('R-EARLY-SAFE-DISCARD-v0：已被碰过的张，早打早安全', () => {
  it('手上单张 4万 已被上家碰过且不在叫口里 → 建议早打', () => {
    const { state, pool } = emptyGame(1011)
    state.players[3].melds = [{ kind: 'peng', tiles: take(pool, '4万 4万 4万'), fromPlayer: 2 }]
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 9条')
    state.players[0].dingque = '筒'
    const hit = allAdvice(state).find(a => a.ruleId === 'R-EARLY-SAFE-DISCARD-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('4万')
    expect(hit!.headline).toContain('安全')
  })
})

// ---------------------------------------------------------------------------
// 第二批接判定化的规则（探针里罕见，用夹具证明它们确实会开口）
// ---------------------------------------------------------------------------

describe('R-THREAT-ESCAPE-v0：识别大牌威胁 → 点炮就走', () => {
  it('对家两副同门副露成型 + 下家点炮 → 必胡，并压住通用底线', () => {
    const { state, pool } = emptyGame(1101)
    state.players[2].dingque = '条'
    state.players[2].melds = [
      { kind: 'peng', tiles: take(pool, '3万 3万 3万'), fromPlayer: 1 },
      { kind: 'peng', tiles: take(pool, '7万 7万 7万'), fromPlayer: 3 },
    ]
    const tile = take(pool, '5万')[0]!
    state.players[0].hand = take(pool, '1万 2万 3万 9条 9条 1筒 2筒 3筒 5筒 6筒 7筒 1条 2条')
    state.players[0].dingque = '条'
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 1,
      tile,
      eligiblePlayers: [0],
      choices: { 0: { type: 'hu', value: 2 } },
      resumePlayer: 1,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    const advice = allAdvice(state)
    const hit = advice.find(a => a.ruleId === 'R-THREAT-ESCAPE-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('点炮就胡')
    // 具体威胁会把通用的「放一手」压掉，避免同一件事说两遍
    expect(advice.some(a => a.ruleId === 'R-SET-BOTTOM-LINE-v0')).toBe(false)
  })
})

describe('R-CHECK-DINGQUE-BEFORE-PONG-v0：早期碰牌前先看缺章', () => {
  it('开局可碰 9筒 且多家缺筒 → 提醒先确认缺章', () => {
    const { state, pool } = emptyGame(1102)
    for (const id of [0, 1, 2, 3] as PlayerId[])
      state.players[id].dingque = null
    state.players[0].dingque = '条'
    state.players[1].dingque = '筒'
    state.players[2].dingque = '筒'
    state.players[3].dingque = '筒'
    state.players[0].hand = take(pool, '9筒 9筒 1万 2万 3万 4万 5万 6万 7万 8万 9万 1筒 2筒')
    const tile = take(pool, '9筒')[0]!
    state.players[1].discards = take(pool, '1条 2条')
    state.responseWindow = {
      kind: 'discard',
      sourcePlayer: 1,
      tile,
      eligiblePlayers: [0],
      choices: { 0: { type: 'peng' } },
      resumePlayer: 1,
      pendingMeldIndex: null,
      sourceEventSequence: 1,
      isLastTile: false,
      isKongDiscard: false,
    }
    const hit = allAdvice(state).find(a => a.ruleId === 'R-CHECK-DINGQUE-BEFORE-PONG-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('缺章')
  })
})

describe('R-SINGLE-LINE-ATTACK-v0：缺章优势转进攻', () => {
  it('三家缺条而自己手握 6 张条 → 提示制定进攻思路', () => {
    const { state, pool } = emptyGame(1103)
    state.players[0].dingque = '筒'
    for (const id of [1, 2, 3] as PlayerId[])
      state.players[id].dingque = '条'
    state.players[0].hand = take(pool, '1条 2条 3条 4条 5条 6条 1万 2万 3万 7万 8万 9万 4万')
    const hit = allAdvice(state).find(a => a.ruleId === 'R-SINGLE-LINE-ATTACK-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('进攻')
  })
})

describe('R-NO-ARMS-RACE-v0：多家做大时不加入军备竞赛', () => {
  it('两家各有两副同门副露 + 自己也想做筒清 → 提示转稳健', () => {
    const { state, pool } = emptyGame(1104)
    state.players[1].dingque = '条'
    state.players[1].melds = [
      { kind: 'peng', tiles: take(pool, '2筒 2筒 2筒'), fromPlayer: 0 },
      { kind: 'peng', tiles: take(pool, '5筒 5筒 5筒'), fromPlayer: 3 },
    ]
    state.players[3].dingque = '条'
    state.players[3].melds = [
      { kind: 'peng', tiles: take(pool, '3筒 3筒 3筒'), fromPlayer: 2 },
      { kind: 'peng', tiles: take(pool, '8筒 8筒 8筒'), fromPlayer: 1 },
    ]
    state.players[0].dingque = '万'
    state.players[0].hand = take(pool, '1筒 2筒 3筒 4筒 5筒 6筒 2条 3条 4条 5条 6条 7条 8条')
    const hit = allAdvice(state).find(a => a.ruleId === 'R-NO-ARMS-RACE-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('军备竞赛')
  })
})

describe('R-DROP-DEAD-PAIR-v0：死对先打别舍不得', () => {
  it('9条对子外面两张已现、且刚刚才绝 → 提示早打腾位置', () => {
    const { state, pool } = emptyGame(1105)
    state.players[0].dingque = '筒'
    state.players[0].hand = take(pool, '9条 9条 1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条')
    const gone = take(pool, '9条 9条')
    state.players[1].discards = [gone[0]!]
    state.players[2].discards = [gone[1]!]
    state.events = [
      { sequence: 1, type: 'tile_discarded', playerId: 2, tile: gone[1]! },
    ]
    const hit = allAdvice(state).find(a => a.ruleId === 'R-DROP-DEAD-PAIR-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('9条')
  })
})

describe('R-KONG-FEED-RISK-v0：别把能喂对手「杠」的牌打出去', () => {
  it('手里有对手已碰且对方副露≥2副的牌 → 命中「喂杠」提醒', () => {
    const { state, pool } = emptyGame(1201)
    // 下家（player[1]）已碰出 4万、8万两副 → 明显在做牌
    state.players[1].melds = [
      { kind: 'peng', tiles: take(pool, '4万 4万 4万'), fromPlayer: 2 },
      { kind: 'peng', tiles: take(pool, '8万 8万 8万'), fromPlayer: 3 },
    ]
    // 自己手上捏着一张 4万（喂杠张），不含 8万以隔离成单张喂杠
    state.players[0].hand = take(pool, '1万 4万 2万 3万 5万 6万 7万 9万 1条 2条 3条 4条 9条')
    const hit = allAdvice(state).find(a => a.ruleId === 'R-KONG-FEED-RISK-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('喂杠')
    expect(hit!.evidence.join(' ')).toContain('4万')
  })

  it('对手副露不足两副 → 静默（杠上花威胁小）', () => {
    const { state, pool } = emptyGame(1202)
    state.players[1].melds = [{ kind: 'peng', tiles: take(pool, '4万 4万 4万'), fromPlayer: 2 }]
    state.players[0].hand = take(pool, '4万 1万 2万 3万 5万 6万 7万 9万 1条 2条 3条 4条 9条')
    expect(allAdvice(state).some(a => a.ruleId === 'R-KONG-FEED-RISK-v0')).toBe(false)
  })

  it('定缺阶段 → 静默', () => {
    const { state, pool } = emptyGame(1203)
    state.phase = 'dingque'
    state.players[1].melds = [
      { kind: 'peng', tiles: take(pool, '4万 4万 4万'), fromPlayer: 2 },
      { kind: 'peng', tiles: take(pool, '8万 8万 8万'), fromPlayer: 3 },
    ]
    state.players[0].hand = take(pool, '4万 1万 2万 3万 5万 6万 7万 9万 1条 2条 3条 4条 9条')
    expect(allAdvice(state).some(a => a.ruleId === 'R-KONG-FEED-RISK-v0')).toBe(false)
  })
})

describe('R-DINGQUE-EARLY-DROP-v0：缺章牌早打掉', () => {
  it('已定缺、未听牌、手里≥2张缺章 → 命中清口提醒', () => {
    const { state, pool } = emptyGame(1211)
    state.players[0].dingque = '筒'
    // 13 张全孤立（无对、无搭），确保未听牌；含 1筒、5筒 两张缺章
    state.players[0].hand = take(pool, '1筒 5筒 1万 3万 5万 7万 9万 2条 4条 6条 8条 9条 2万')
    const hit = allAdvice(state).find(a => a.ruleId === 'R-DINGQUE-EARLY-DROP-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('缺章')
    expect(hit!.evidence.join(' ')).toContain('筒')
  })

  it('已经听牌（再打缺章会拆叫）→ 静默', () => {
    const { state, pool } = emptyGame(1212)
    state.players[0].dingque = '条'
    // 四副顺子 + 单 5万（单调 5万听牌），无缺章在手的干扰
    state.players[0].hand = take(pool, '1筒 2筒 3筒 4筒 5筒 6筒 7筒 8筒 9筒 1万 2万 3万 5万')
    expect(allAdvice(state).some(a => a.ruleId === 'R-DINGQUE-EARLY-DROP-v0')).toBe(false)
  })

  it('手里只有 1 张缺章（正常不催促）→ 静默', () => {
    const { state, pool } = emptyGame(1213)
    state.players[0].dingque = '筒'
    state.players[0].hand = take(pool, '1筒 1万 3万 5万 7万 9万 2条 4条 6条 8条 9条 2万 4万')
    expect(allAdvice(state).some(a => a.ruleId === 'R-DINGQUE-EARLY-DROP-v0')).toBe(false)
  })
})

describe('R-XIAJIAO-QUALITY-v0：下叫质量优先于「有叫没叫」', () => {
  it('中前期能听但最佳叫是死叫（活张≤1）→ 命中死叫提醒', () => {
    const { state, pool } = emptyGame(1221)
    state.players[0].dingque = '条'
    // 四副顺子 + 单 5万（单调 5万），且 5万 三张已现 → 活张仅 1
    state.players[0].hand = take(pool, '1筒 2筒 3筒 4筒 5筒 6筒 7筒 8筒 9筒 1万 2万 3万 5万')
    const gone = take(pool, '5万 5万 5万')
    state.players[2].discards = [gone[0]!]
    state.players[3].discards = [gone[1]!, gone[2]!]
    const hit = allAdvice(state).find(a => a.ruleId === 'R-XIAJIAO-QUALITY-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('死叫')
  })

  it('能听且叫口宽（活张多）→ 不催促死叫', () => {
    const { state, pool } = emptyGame(1222)
    state.players[0].dingque = '条'
    state.players[0].hand = take(pool, '1筒 2筒 3筒 4筒 5筒 6筒 7筒 8筒 9筒 1万 2万 3万 5万')
    // 5万 一张都没现 → 活张 4，宽叫不提醒
    expect(allAdvice(state).some(a => a.ruleId === 'R-XIAJIAO-QUALITY-v0')).toBe(false)
  })

  it('尾盘（牌墙将尽）→ 任何叫都比死等强，静默', () => {
    const { state, pool } = emptyGame(1223)
    state.players[0].dingque = '条'
    state.players[0].hand = take(pool, '1筒 2筒 3筒 4筒 5筒 6筒 7筒 8筒 9筒 1万 2万 3万 5万')
    const gone = take(pool, '5万 5万 5万')
    state.players[2].discards = [gone[0]!]
    state.players[3].discards = [gone[1]!, gone[2]!]
    state.wall = pool.slice(0, 10) // 牌墙剩 10 张（尾盘）
    expect(allAdvice(state).some(a => a.ruleId === 'R-XIAJIAO-QUALITY-v0')).toBe(false)
  })
})

describe('R-KEEP-LIVE-v0：碰后孤张二选一用牌河算账', () => {
  it('5筒邻张已现 3 张、9筒全无信息 → 留 5筒打 9筒', () => {
    const { state, pool } = emptyGame(1106)
    state.players[0].dingque = '条'
    state.players[0].melds = [{ kind: 'peng', tiles: take(pool, '3万 3万 3万'), fromPlayer: 1 }]
    state.players[0].hand = take(pool, '1万 2万 3万 1条 2条 3条 7条 8条 9条 5筒 9筒')
    // 5筒 的邻张（3/4/6/7筒）被下家打过 3 张 → 它更可能还在墙里
    state.players[1].discards = take(pool, '3筒 4筒 6筒')
    state.events = [
      { sequence: 1, type: 'meld_declared', playerId: 0, meld: state.players[0].melds[0]!, replacedMeldIndex: null },
    ]
    const hit = allAdvice(state).find(a => a.ruleId === 'R-KEEP-LIVE-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('5筒')
  })
})

describe('R-EXPECT-MINDSET-v0：期望收益意识，结果不改打法', () => {
  it('刚刚放过一次和牌 → 提醒按长期主义执行', () => {
    const { state, pool } = emptyGame(1107)
    state.players[0].dingque = '筒'
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 4条')
    state.events = [
      { sequence: 1, type: 'passed_win_set', playerId: 0, value: 2 },
    ]
    const hit = allAdvice(state).find(a => a.ruleId === 'R-EXPECT-MINDSET-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('别让结果改了你的打法')
  })
})

describe('R-DROP-FUTURE-RISK-v0：留久成祸的张要早打', () => {
  /**
   * 造「自己 14 张、孤张 8筒（河里已见 2 张）」的局面；
   * 下家（玩家 1）的定缺与弃牌由用例定制。
   * 背景：2026-09-11 破晓实测误报——对手定缺万、被迫先打缺门，其它门弃得少
   * 被判「在收筒」。修复口径：只读他清缺之后打出的牌。
   */
  function futureRiskGame(seed: number, opDiscards: string, opDingque: TileType) {
    const { state, pool } = emptyGame(seed)
    state.players[1].dingque = opDingque
    state.players[1].discards = take(pool, opDiscards)
    state.players[2].discards = take(pool, '8筒') // 河 8筒 ×2 → 自己的 8筒 墘里最多剩 1 张
    state.players[3].discards = take(pool, '8筒')
    state.players[0].hand = take(pool, '1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 4条 8筒')
    return { state }
  }

  it('对手还在清缺门时弃牌分布不可读 → 静默（误报回归）', () => {
    // 定缺万 + 弃「万4 条2」：清缺后只打过 2 张，样本不足，不能断言他在收筒
    const { state } = futureRiskGame(901, '1万 2万 3万 4万 5条 6条', '万')
    expect(buildXiaoshiAdvice(state, 0).find(a => a.ruleId === 'R-DROP-FUTURE-RISK-v0')).toBeUndefined()
  })

  it('对手清缺后连打 3 张非筒且筒门 0 张 → 命中「在收筒」', () => {
    // 定缺万 + 弃「万4 条3」：清缺后打了 3 张条、筒门 0 张 → 真实收筒信号
    const { state } = futureRiskGame(902, '1万 2万 3万 4万 5条 6条 7条', '万')
    const hit = buildXiaoshiAdvice(state, 0).find(a => a.ruleId === 'R-DROP-FUTURE-RISK-v0')
    expect(hit).toBeDefined()
    expect(hit!.headline).toContain('下家')
    expect(hit!.headline).toContain('收筒')
    expect(hit!.evidence.join('')).toContain('清缺后')
  })

  it('对手清缺后打过筒子 → 他没在收筒，静默', () => {
    // 定缺万 + 弃「万4 条3 筒1」：清缺后打过 1 张筒 → 收筒前提不成立
    const { state } = futureRiskGame(903, '1万 2万 3万 4万 5条 6条 7条 8筒', '万')
    expect(buildXiaoshiAdvice(state, 0).find(a => a.ruleId === 'R-DROP-FUTURE-RISK-v0')).toBeUndefined()
  })
})

describe('makeQuoteBridge：案例花色 vs 当前局主门桥接', () => {
  const maxLive = getXiaoshiRule('R-MAX-LIVE-WAIT-v0')! // rationale 含「九条」
  const pairDown = getXiaoshiRule('R-PAIR-COUNT-DOWN-v0')! // rationale 不含具体花色

  it('案例举条子、当前局是万子门 → 出桥接，明确「案例花色非指令、思路通用」', () => {
    const bridge = makeQuoteBridge(maxLive, '万')
    expect(bridge).not.toBeNull()
    expect(bridge).toContain('条子')
    expect(bridge).toContain('万子门')
    expect(bridge).toContain('不是你当前手牌的指令')
  })

  it('案例举条子、当前局也是条子门 → 同花色不桥接', () => {
    expect(makeQuoteBridge(maxLive, '条')).toBeNull()
  })

  it('无当前主门（mainSuit=null）→ 不桥接', () => {
    expect(makeQuoteBridge(maxLive, null)).toBeNull()
  })

  it('金句本身不含具体花色 → 不桥接', () => {
    expect(makeQuoteBridge(pairDown, '万')).toBeNull()
  })
})

describe('matchUserAngles：用户视角挂载', () => {
  const angleA = { id: 'a1', ruleId: 'R-RIVER-INFER-v0', theme: null, text: '下家打 7/9 筒也可能在拆搭，别太武断' }
  const angleB = { id: 'b1', ruleId: null, theme: '形势与信息' as DecisionTheme, text: '信息少时我更倾向保守' }
  const angleC = { id: 'c1', ruleId: 'R-OTHER-v0', theme: null, text: '不相关角度' }

  it('ruleId 精确命中（主题不匹配时不串入通用角度）', () => {
    expect(matchUserAngles('R-RIVER-INFER-v0', '防守与逃跑', [angleA, angleB, angleC])).toEqual([angleA])
  })
  it('ruleId 为 null 时按 theme 命中', () => {
    expect(matchUserAngles('R-RIVER-INFER-v0', '形势与信息', [angleB])).toEqual([angleB])
  })
  it('ruleId 为 null 且 theme 不匹配则不命中', () => {
    expect(matchUserAngles('R-RIVER-INFER-v0', '防守与逃跑', [angleB])).toEqual([])
  })
  it('每卡上限 2 条', () => {
    const many = [1, 2, 3].map(i => ({ id: `m${i}`, ruleId: 'R-RIVER-INFER-v0', theme: null, text: `x${i}` }))
    expect(matchUserAngles('R-RIVER-INFER-v0', '形势与信息', many)).toHaveLength(2)
  })

  it('端到端：buildXiaoshiAdvice 把用户角度挂回同类命中', () => {
    const { state, pool } = emptyGame(801)
    const discardTiles = take(pool, '7筒 9筒 1万')
    state.players[1].discards = discardTiles
    state.players[1].dingque = '条'
    state.players[3].discards = take(pool, '2万')
    state.players[0].hand = take(pool, '8筒 9筒')
    const advice = buildXiaoshiAdvice(state, 0, { userAngles: [angleA, angleB, angleC] })
    const hit = advice.find(a => a.ruleId === 'R-RIVER-INFER-v0')
    expect(hit).toBeDefined()
    expect(hit!.userAngles).toBeDefined()
    expect(hit!.userAngles!.map(x => x.id)).toContain('a1')
    // 该规则未设 theme（null），故 ruleId 为 null 的 theme 角度不应挂载
    expect(hit!.userAngles!.map(x => x.id)).not.toContain('b1')
    // 不相关角度不应挂载
    expect(hit!.userAngles!.map(x => x.id)).not.toContain('c1')
  })
})
