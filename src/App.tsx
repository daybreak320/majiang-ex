import type { GameState } from './game/types'
import { useEffect, useState } from 'react'
import { MajiangHand } from './components/MajiangHand'
import { ParticleBackground } from './components/ParticleBackground'
import { SichuanGame } from './components/SichuanGame'
import { APP_VERSION } from './config/release'
import { loadUnfinishedGame } from './game/persistence'
import { SPECIAL_TRAINING_META } from './game/core'
import type { SpecialTrainingKind } from './game/core'

type Page = 'home' | 'game'

function nextSeed(): number {
  return Math.floor((Date.now() + Math.random() * 0x7FFFFFFF) % 0x7FFFFFFF)
}

function App() {
  const [page, setPage] = useState<Page>('home')
  const [seed, setSeed] = useState(nextSeed)
  const [savedGame, setSavedGame] = useState<GameState | null>(null)
  const [timedTraining, setTimedTraining] = useState(false)
  const [trainingKind, setTrainingKind] = useState<SpecialTrainingKind | null>(null)
  const [ignoreSavedGame, setIgnoreSavedGame] = useState(false)

  useEffect(() => {
    if (ignoreSavedGame)
      return
    const saved = loadUnfinishedGame()
    setSavedGame(saved?.state ?? null)
    if (saved !== null)
      setTimedTraining(saved.options?.timedTraining ?? false)
  }, [page, ignoreSavedGame])

  const startGame = () => {
    setIgnoreSavedGame(true)
    setSavedGame(null)
    setTrainingKind(null)
    setSeed(nextSeed())
    setPage('game')
  }

  const startSpecialTraining = (kind: SpecialTrainingKind) => {
    setIgnoreSavedGame(true)
    setSavedGame(null)
    setTrainingKind(kind)
    setSeed(nextSeed())
    setPage('game')
  }

  const continueGame = () => {
    if (savedGame === null)
      return
    setSeed(savedGame.seed)
    setPage('game')
  }

  if (page === 'game')
    return <SichuanGame key={seed} seed={seed} restoredState={savedGame ?? undefined} timedTraining={timedTraining} trainingKind={savedGame === null ? trainingKind ?? undefined : undefined} onHome={() => setPage('home')} onNewGame={startGame} />

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
        <section className="battle-card">
          <div className="battle-copy">
            <span className="live-badge">首个可玩版本</span>
            <h2>四人实战</h2>
            <p>你将固定坐在下方，与进攻型、稳健型、效率型三种 AI 完成一整局成都血战到底。</p>
            <ul>
              <li>自主定缺与合法动作提示</li>
              <li>四家独立牌河、鸣牌与实时分数</li>
              <li>胡牌公开、终局排名与完整计分流水</li>
            </ul>
          </div>
          <div className="battle-visual" aria-hidden="true">
            <span>青锋</span>
            <span>沉舟</span>
            <strong>血战到底</strong>
            <span>逐浪</span>
            <span>你</span>
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
            <button className="secondary-action battle-start" onClick={startGame}>开始新局</button>
          </div>
        </section>
        <section className="scenario-training-section">
          <div className="section-heading">
            <span className="eyebrow">实战专项训练</span>
            <h2>带倾向的牌局，不再只靠随机发牌</h2>
            <p>每类训练都固定关键牌型和公开局势；打开出牌助手可逐手核对机会数、叫口、风险与导师解释。</p>
          </div>
          <div className="scenario-training-grid">
            {(Object.keys(SPECIAL_TRAINING_META) as SpecialTrainingKind[]).map(kind => (
              <article className={`scenario-training-card scenario-${kind}`} key={kind}>
                <span>{kind.startsWith('attack') ? '进攻训练' : kind.startsWith('defense') ? '防守训练' : '残局算牌'}</span>
                <h3>{SPECIAL_TRAINING_META[kind].title}</h3>
                <p>{SPECIAL_TRAINING_META[kind].summary}</p>
                <button className="secondary-action" onClick={() => startSpecialTraining(kind)}>进入专项</button>
              </article>
            ))}
          </div>
        </section>
        <section className="training-section">
          <div className="section-heading">
            <span className="eyebrow">基本功训练</span>
            <h2>听牌、舍牌、速度与牌型</h2>
            <p>基础练习保持独立，适合热身和单点重复训练。</p>
          </div>
          <MajiangHand />
        </section>
      </div>
    </div>
  )
}

export default App
