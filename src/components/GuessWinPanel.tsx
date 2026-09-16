import type { GuessWinPlayer, GuessWinWait, TenpaiMemory, TenpaiMemoryEntry } from '../game/guessWin'
import type { GameState } from '../game/types'
import type { WaitShape } from '../knowledge/mahjongTheory'
import type { Tile } from '../types'
import { useMemo, useState } from 'react'
import { analyzeGuessWin, describeConcealed, positionLabel } from '../game/guessWin'
import { WinningBreakdown } from './WinningBreakdown'

const WAIT_SHAPE_LABEL: Record<WaitShape, string> = {
  single: '单钓 / 单骑',
  kanchan: '嵌张听',
  twoSided: '两面听',
  threeSided: '三面听',
  other: '其他听',
}

const CONF_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: '高可能',
  medium: '中可能',
  low: '低可能',
}

function WaitDecompose({ waits, hand13, meldTiles }: { waits: GuessWinWait[], hand13: Tile[], meldTiles: Tile[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  if (waits.length === 0)
    return <span>暂无可胡叫口</span>
  return (
    <>
      {waits.map((wait) => {
        const key = `${wait.tile.type}-${wait.tile.value}`
        const open = openKey === key
        return (
          <div key={key} className="wait-row">
            <button
              type="button"
              className={`wait-chip${wait.dead ? ' wait-dead' : ''}`}
              onClick={() => setOpenKey(open ? null : key)}
            >
              <span>
                {wait.tile.value}
                {wait.tile.type}
                {' '}
                ×
                {wait.remaining}
                {' '}
                ·
                {' '}
                {(wait.prob * 100).toFixed(1)}
                %
                {wait.baseFan > 0 ? ` · ${wait.baseFan}番` : ''}
                {wait.dead ? ' · 死叫' : ''}
              </span>
              <span className="see-reason">{open ? '收起 ◂' : '看推演 ▸'}</span>
            </button>
            {open && hand13.length > 0 && (
              <div className="wait-reason-box">
                <WinningBreakdown hand={[...hand13, ...meldTiles]} tingTiles={[wait.tile]} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function PlayerGuessCard({ player }: { player: GuessWinPlayer }) {
  const nameSuffix = player.displayName !== player.position ? `（${player.displayName}）` : ''
  return (
    <article>
      <header>
        <strong>
          {player.position}
          {nameSuffix}
        </strong>
        <span>
          {player.dingque === null ? '未定缺' : `定缺${player.dingque}${player.clearedDingque ? '·已清' : '·未清'}`}
          {' · '}
          {WAIT_SHAPE_LABEL[player.waitShape]}
          {' '}
          · 活张
          {' '}
          {player.totalOpportunity}
        </span>
      </header>

      <h4 className="guess-section">
        <span>① 穷举收敛 · 叫口概率</span>
        <small>
          点击叫口右侧「看推演」，查看 AI 为什么能胡这张牌 · 未知牌
          {player.unknownTiles}
          {' '}
          张
        </small>
      </h4>
      <div className="assistant-waits">
        <WaitDecompose waits={player.waits} hand13={player.hand13} meldTiles={player.meldTiles} />
        {player.waits.length === 1 && <span className="wait-single">单钓 · 仅此 1 张可胡（非漏算）</span>}
      </div>

      <h4 className="guess-section">
        <span>② 大胆猜测 · 手牌组合</span>
        <small>成牌规则反推 + 公开信号</small>
      </h4>
      {player.hypotheses.map((hypothesis, index) => (
        <p className="guess-hypothesis" key={index}>
          <b className={`inference-${hypothesis.confidence}`}>{CONF_LABEL[hypothesis.confidence]}</b>
          {hypothesis.label}
          <span className="guess-reason">{hypothesis.reason}</span>
          {hypothesis.concealed.length > 0 && (
            <span className="guess-concealed">
              推测暗手：
              {describeConcealed(hypothesis.concealed, hypothesis.waitTiles)}
              {hypothesis.winsOn.length > 0 && ` → 听 ${hypothesis.winsOn.map(t => `${t.value}${t.type}`).join('/')}`}
            </span>
          )}
        </p>
      ))}
    </article>
  )
}

function MemoryGuessCard({ id, entry }: { id: number, entry: TenpaiMemoryEntry }) {
  const position = entry.lastDetail?.position ?? positionLabel(id as 0 | 1 | 2 | 3)
  const status = entry.won ? '已胡' : '曾听（已变型）'
  const detail = entry.lastDetail
  return (
    <article className="memory-guess-card">
      <header>
        <strong>{position}</strong>
        <span className="muted">{status}</span>
      </header>
      {detail
        ? (
            <>
              <div className="assistant-waits">
                <WaitDecompose waits={detail.waits} hand13={detail.hand13} meldTiles={detail.meldTiles} />
              </div>
              {detail.hypotheses.slice(0, 2).map((hypothesis, index) => (
                <p className="guess-hypothesis" key={index}>
                  <b className={`inference-${hypothesis.confidence}`}>{CONF_LABEL[hypothesis.confidence]}</b>
                  {hypothesis.label}
                  <span className="guess-reason">{hypothesis.reason}</span>
                </p>
              ))}
            </>
          )
        : <p className="muted">（无末次听牌细表）</p>}
    </article>
  )
}

export function GuessWinPanel({ state, memory }: { state: GameState, memory?: TenpaiMemory }) {
  const result = useMemo(() => analyzeGuessWin(state), [state])
  const liveIds = useMemo(() => new Set<number>(result.players.map(p => p.playerId)), [result])
  const memoryCards = useMemo(() => {
    if (!memory)
      return []
    return Object.entries(memory)
      .filter(([rawId, entry]) => {
        const id = Number(rawId)
        return id !== 0 && !liveIds.has(id) && (entry.won || entry.everTenpai)
      })
      .map(([rawId, entry]) => ({ id: Number(rawId), entry }))
  }, [memory, liveIds])
  return (
    <aside className="endgame-defense-panel guess-win-panel" aria-label="对手雷达 · 叫口推演">
      <header className="endgame-defense-heading">
        <div>
          <span className="eyebrow">叫口推演 · 停听说牌分析</span>
          <h3>{result.active ? `${result.players.length} 家停牌 · 牌墙剩 ${result.wallTiles} 张` : '暂无玩家停牌'}</h3>
          {memoryCards.length > 0 && (
            <p className="muted tenpai-hint">
              本局另有
              {memoryCards.length}
              {' '}
              家曾听 / 已胡，见下方「对手态势」。
            </p>
          )}
        </div>
        <p>
          路径一「穷举收敛」按定缺 / 牌河 / 自己手牌扣张，列出每个听牌者可能胡的牌与概率；
          路径二「大胆猜测」按成牌规则反推其手牌组合，并附公开信号置信度。
        </p>
      </header>
      {result.active && (
        <div className="endgame-opponents">
          {result.players.map(player => <PlayerGuessCard key={player.playerId} player={player} />)}
        </div>
      )}
      {memoryCards.length > 0 && (
        <div className="endgame-opponents memory-section">
          <h4 className="guess-section">
            <span>本局对手态势（含已胡 / 曾听）</span>
            <small>跨回合持续追踪</small>
          </h4>
          {memoryCards.map(({ id, entry }) => <MemoryGuessCard key={id} id={id} entry={entry} />)}
        </div>
      )}
      {!result.active && memoryCards.length === 0 && (
        <p className="muted">牌局进行中，还没有人下叫；一旦有人停牌，这里会自动列出猜牌看板。</p>
      )}
    </aside>
  )
}
