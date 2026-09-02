import type { AIStyle, GameState, OpponentConfig } from './game/types'
import { useEffect, useState } from 'react'
import { MajiangHand } from './components/MajiangHand'
import { ParticleBackground } from './components/ParticleBackground'
import { SichuanGame } from './components/SichuanGame'
import { APP_VERSION } from './config/release'
import { loadUnfinishedGame } from './game/persistence'
import { loadPlayerTrainingProfile, recordTrainingStart, savePlayerId, takeNextSpecialTrainingIndex } from './utils/playerProfile'
import { getSpecialTrainingScenarioCount, SPECIAL_TRAINING_META } from './game/core'
import type { SpecialTrainingKind } from './game/core'
import { HomeDashboard } from './components/HomeDashboard'
import { TrainingLibrary } from './components/TrainingLibrary'

type Page = 'home' | 'game' | 'library'

const SPECIAL_TRAINING_VISUALS: Record<SpecialTrainingKind, { icon: string, category: string, color: string }> = {
  'attack-qingyise': { icon: '🛏️', category: '进攻决策', color: 'from-sky-500 to-blue-500' },
  'attack-jingoudiao': { icon: '🎣', category: '残局换听', color: 'from-violet-500 to-fuchsia-500' },
  'defense-big-hands': { icon: '🛡️', category: '防守训练', color: 'from-rose-500 to-red-500' },
  'defense-race-qingyise': { icon: '⚔️', category: '攻防对抗', color: 'from-orange-500 to-amber-500' },
  'endgame-count': { icon: '🧮', category: '残局算牌', color: 'from-emerald-500 to-teal-500' },
  'endgame-qingyise-tenpai': { icon: '📡', category: '下宽叫', color: 'from-cyan-500 to-indigo-500' },
}

function nextSeed(): number {
  return Math.floor((Date.now() + Math.random() * 0x7FFFFFFF) % 0x7FFFFFFF)
}

const OPPONENT_STYLE_OPTIONS: readonly { style: AIStyle, label: string, name: string, description: string }[] = [
  { style: 'aggressive', label: '进攻型', name: '搞死搞残做大做强', description: '爱冲速度与大牌，能碰就碰。' },
  { style: 'steady', label: '稳健型', name: '一路小屁走向胜利', description: '兼顾牌效和公开牌河风险。' },
  { style: 'efficient', label: '效率型', name: '先赢是纸', description: '把有效进张与下叫速度放第一。' },
  { style: 'qingyise', label: '清一色狂热爱好者', name: '做了个寂寞', description: '一门牌够多就上头，宁愿为做大牌绕路。' },
  { style: 'turtle', label: '逃跑保守派', name: '心头慌打中张', description: '对手一副露就找熟张，常年把安全放在第一。' },
  { style: 'pengManiac', label: '自摸杠开狂热爱好者', name: '上碰下自摸', description: '偏爱自摸与杠后补张；只有杠后仍保住结构时才会积极开杠。' },
]

const AI_STYLE_AVATARS: Record<AIStyle, string> = {
  aggressive: '🐯',
  steady: '🐢',
  efficient: '🦊',
  qingyise: '🦚',
  turtle: '🦥',
  pengManiac: '🦦',
}

const DEFAULT_OPPONENTS: readonly OpponentConfig[] = [
  { name: '搞死搞残做大做强', aiStyle: 'aggressive' },
  { name: '先赢是纸', aiStyle: 'efficient' },
  { name: '一路小屁走向胜利', aiStyle: 'steady' },
]

function App() {
  const [page, setPage] = useState<Page>('home')
  const [seed, setSeed] = useState(nextSeed)
  const [savedGame, setSavedGame] = useState<GameState | null>(null)
  const [timedTraining, setTimedTraining] = useState(false)
  const [trainingKind, setTrainingKind] = useState<SpecialTrainingKind | null>(null)
  const [trainingScenarioIndex, setTrainingScenarioIndex] = useState<number | null>(null)
  const [specialTrainingRounds, setSpecialTrainingRounds] = useState<Partial<Record<SpecialTrainingKind, number>>>({})
  const [opponents, setOpponents] = useState<OpponentConfig[]>(() => DEFAULT_OPPONENTS.map(opponent => ({ ...opponent })))
  const [ignoreSavedGame, setIgnoreSavedGame] = useState(false)
  const [playerId, setPlayerId] = useState(() => loadPlayerTrainingProfile()?.playerId ?? '')
  const [playerIdDraft, setPlayerIdDraft] = useState(() => loadPlayerTrainingProfile()?.playerId ?? '')
  const [showPlayerIdModal, setShowPlayerIdModal] = useState(false)
  const [pendingTrainingKind, setPendingTrainingKind] = useState<SpecialTrainingKind | null>(null)
  const [pendingStartGame, setPendingStartGame] = useState(false)
  const trainingProfile = loadPlayerTrainingProfile()
  const specialCompletion = trainingProfile?.specialTrainingCompleted ?? {}
  const recommendedTraining = (Object.keys(SPECIAL_TRAINING_META) as SpecialTrainingKind[])
    .sort((left, right) => (specialCompletion[`专项 · ${SPECIAL_TRAINING_META[left].title}`] ?? 0) - (specialCompletion[`专项 · ${SPECIAL_TRAINING_META[right].title}`] ?? 0))[0] ?? 'attack-qingyise'

  useEffect(() => {
    if (ignoreSavedGame)
      return
    const saved = loadUnfinishedGame()
    setSavedGame(saved?.state ?? null)
    if (saved !== null)
      setTimedTraining(saved.options?.timedTraining ?? false)
  }, [page, ignoreSavedGame])

  const startGame = (playerIdOverride?: string) => {
    const effectivePlayerId = playerIdOverride ?? playerId
    if (!effectivePlayerId) {
      setPendingTrainingKind(null)
      setPendingStartGame(true)
      setShowPlayerIdModal(true)
      return
    }
    recordTrainingStart('实战训练')
    setIgnoreSavedGame(true)
    setSavedGame(null)
    setTrainingKind(null)
    setTrainingScenarioIndex(null)
    setSeed(nextSeed())
    setPage('game')
  }

  const updateOpponent = (index: number, patch: Partial<OpponentConfig>) => {
    setOpponents(current => current.map((opponent, opponentIndex) => opponentIndex === index ? { ...opponent, ...patch } : opponent))
  }

  const updateOpponentStyle = (index: number, aiStyle: AIStyle) => {
    const option = OPPONENT_STYLE_OPTIONS.find(candidate => candidate.style === aiStyle)!
    updateOpponent(index, { aiStyle, name: option.name })
  }

  const startSpecialTraining = (kind: SpecialTrainingKind) => {
    if (!playerId) {
      setPendingTrainingKind(kind)
      setShowPlayerIdModal(true)
      return
    }
    const scenarioCount = getSpecialTrainingScenarioCount(kind)
    const trainingLabel = `专项 · ${SPECIAL_TRAINING_META[kind].title}`
    const nextRound = (specialTrainingRounds[kind] ?? -1) + 1
    // 每个专项都从玩家自己的题库游标领取，刷新页面或回首页也不会重新回到第一题。
    const scenarioIndex = takeNextSpecialTrainingIndex(trainingLabel, scenarioCount) ?? nextRound % scenarioCount
    const scenarioSeed = nextSeed()
    recordTrainingStart(trainingLabel)
    setSpecialTrainingRounds(current => ({ ...current, [kind]: nextRound }))
    setIgnoreSavedGame(true)
    setSavedGame(null)
    setTrainingKind(kind)
    setTrainingScenarioIndex(scenarioIndex)
    setSeed(scenarioSeed)
    setPage('game')
  }

  const continueGame = () => {
    if (savedGame === null || !playerId)
      return
    setSeed(savedGame.seed)
    setPage('game')
  }

  const confirmPlayerId = () => {
    const normalized = playerIdDraft.trim()
    if (!normalized)
      return
    savePlayerId(normalized)
    setPlayerId(normalized)
    setShowPlayerIdModal(false)
    const nextTrainingKind = pendingTrainingKind
    const shouldStartGame = pendingStartGame
    setPendingTrainingKind(null)
    setPendingStartGame(false)
    if (nextTrainingKind !== null)
      startSpecialTraining(nextTrainingKind)
    else if (shouldStartGame)
      startGame(normalized)
  }

  const openPlayerIdEditor = () => {
    setPlayerIdDraft(playerId)
    setPendingTrainingKind(null)
    setShowPlayerIdModal(true)
  }

  if (page === 'library')
    return <main className="home-page min-h-screen w-full"><div className="container mx-auto py-8 px-4"><button className="secondary-action" onClick={() => setPage('home')}>返回首页</button><TrainingLibrary onSelect={kind => { startSpecialTraining(kind) }} /></div></main>

  if (page === 'game')
    return <SichuanGame key={seed} seed={seed} restoredState={savedGame ?? undefined} timedTraining={timedTraining} opponentConfigs={savedGame === null ? opponents : undefined} trainingKind={savedGame === null ? trainingKind ?? undefined : undefined} trainingScenarioIndex={savedGame === null ? trainingScenarioIndex ?? undefined : undefined} onHome={() => setPage('home')} onNewGame={startGame} onStartTraining={startSpecialTraining} />

  return (
    <div className="home-page min-h-screen w-full relative">
      <ParticleBackground count={28} />
      <div className="container mx-auto py-8 px-4 relative z-10">
        <header className="home-hero">
          <div>
            <span className="eyebrow">麻将练习场 · 实战版</span>
            <h1>从牌效训练，到四方牌桌</h1>
            <p>完整体验成都血战到底：定缺、碰杠胡、三家 AI 对抗与逐笔结算。</p>
            <span className="release-version">
              内测版
              {' '}
              {APP_VERSION}
            </span>
          </div>
        </header>
        <HomeDashboard playerId={playerId} onStart={startGame} onEditPlayerId={openPlayerIdEditor} onOpenLibrary={() => setPage('library')} />
        {showPlayerIdModal && (
          <div className="player-id-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowPlayerIdModal(false) }}>
            <section className="player-id-modal" role="dialog" aria-modal="true" aria-labelledby="player-id-modal-title">
              <span className="eyebrow">身份设置</span>
              <h2 id="player-id-modal-title">填写名字 ID</h2>
              <p>确认后即可进入实战训练；训练库仍可独立浏览。</p>
              <input autoFocus aria-label="名字 ID" maxLength={12} value={playerIdDraft} placeholder="例如：成都雀神" onChange={event => setPlayerIdDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') confirmPlayerId() }} />
              <div className="player-id-modal-actions"><button className="secondary-action" onClick={() => setShowPlayerIdModal(false)}>取消</button><button className="primary-action" onClick={confirmPlayerId} disabled={!playerIdDraft.trim()}>确认并继续</button></div>
            </section>
          </div>
        )}
        <div className={!playerId ? 'training-locked' : ''}>
        <section className="battle-card" aria-labelledby="battle-training-title">
          <div className="battle-copy">
            <span className="eyebrow">实战训练</span>
            <h2 id="battle-training-title">四人实战</h2>
            <p>成都血战到底</p>
          </div>
          <div className="battle-visual" aria-label="四人牌桌，可直接选择三名 AI 对手">
            {opponents.map((opponent, index) => (
              <details className={`opponent-seat-picker opponent-seat-${index}`} key={index}>
                <summary aria-label={`选择对手：${opponent.name}`}>
                  <span className={`opponent-avatar opponent-avatar-${index}`} aria-hidden="true">{AI_STYLE_AVATARS[opponent.aiStyle]}</span>
                  <b>{opponent.name}</b>
                </summary>
                <div className="opponent-seat-options">
                  {OPPONENT_STYLE_OPTIONS.map(option => (
                    <button key={option.style} className={option.style === opponent.aiStyle ? 'selected' : ''} onClick={() => updateOpponentStyle(index, option.style)}>{option.name}</button>
                  ))}
                </div>
              </details>
            ))}
            <span className="player-id-seat">
              <span className="player-avatar" aria-hidden="true">🐼</span>
              <div>
                <input
                  aria-label="玩家名字 ID"
                  maxLength={12}
                  value={playerIdDraft}
                  placeholder="名字 ID"
                  onChange={event => setPlayerIdDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') confirmPlayerId() }}
                />
                <button aria-label="确认名字 ID" onClick={confirmPlayerId} disabled={!playerIdDraft.trim()}>✓</button>
              </div>
            </span>
          </div>
          <div className="battle-actions">
            <label className="pregame-option">
              <input
                type="checkbox"
                checked={timedTraining}
                onChange={event => setTimedTraining(event.target.checked)}
              />
              <span>
                <strong>思考计时训练</strong>
                <small>{timedTraining ? '出牌 15 秒 · 响应 8 秒' : '自由思考 · 不自动代打'}</small>
              </span>
            </label>
            {savedGame !== null && <button className="primary-action battle-start" onClick={continueGame}>继续牌局</button>}
            <button className="secondary-action battle-start" onClick={() => startGame()}>开始新局</button>
          </div>
        </section>
        <section className="training-section" aria-labelledby="basic-training-title">
          <div className="section-heading">
            <span className="eyebrow">基本功训练</span>
            <h2 id="basic-training-title">先练听牌、舍牌、识型和速度</h2>
            <p>短题反复练手感：出牌练习会先遵守川麻定缺，清缺后再比较牌效、金线与搭子。</p>
          </div>
          <MajiangHand />
        </section>
        {trainingProfile !== null && (
          <section className="training-profile-card" aria-label="你的专项训练档案">
            <div>
              <span className="eyebrow">你的训练档案</span>
              <h2>{trainingProfile.playerId}，下一项建议练「{SPECIAL_TRAINING_META[recommendedTraining].title}」</h2>
              <p>优先补齐练得最少的专项；完成专项后会自动计入这里。</p>
            </div>
            <div className="training-profile-stats">
              <strong>{Object.values(specialCompletion).reduce<number>((total, count) => total + (count ?? 0), 0)}</strong>
              <span>完成专项局</span>
              <button className="primary-action compact" onClick={() => startSpecialTraining(recommendedTraining)}>开始建议专项</button>
            </div>
          </section>
        )}
        <section className="scenario-training-section" aria-labelledby="scenario-training-title">
          <div className="section-heading">
            <span className="eyebrow">专项训练</span>
            <h2 id="scenario-training-title">固定局势，把一种关键能力练透</h2>
            <p>每项都有明确题面、公开证据与 AI 导师；进入后是完整四人局面，而不是普通随机发牌。</p>
          </div>
          <div className="scenario-training-grid">
            {(Object.keys(SPECIAL_TRAINING_META) as SpecialTrainingKind[]).map((kind) => {
              const isEndgame = kind === 'attack-jingoudiao' || kind === 'endgame-count' || kind === 'endgame-qingyise-tenpai'
              const visual = SPECIAL_TRAINING_VISUALS[kind]
              return (
                <button className={`scenario-training-card scenario-${kind} ${isEndgame ? 'scenario-endgame-card' : ''}`} key={kind} onClick={() => startSpecialTraining(kind)}>
                  <span className={`scenario-training-icon bg-gradient-to-br ${visual.color}`} aria-hidden="true">{visual.icon}</span>
                  <span className="scenario-training-category">{visual.category}</span>
                  <h3>{SPECIAL_TRAINING_META[kind].title}</h3>
                  <p>{SPECIAL_TRAINING_META[kind].summary}</p>
                  <b>进入实战专项 →</b>
                </button>
              )
            })}
          </div>
        </section>
        </div>
      </div>
    </div>
  )
}

export default App
