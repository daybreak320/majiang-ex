import type { GameState } from './game/types'
import { useEffect, useState } from 'react'
import { MajiangHand } from './components/MajiangHand'
import { ParticleBackground } from './components/ParticleBackground'
import { SichuanGame } from './components/SichuanGame'
import { loadUnfinishedGame } from './game/persistence'

type Page = 'home' | 'game'

function nextSeed(): number {
  return Math.floor((Date.now() + Math.random() * 0x7FFFFFFF) % 0x7FFFFFFF)
}

function App() {
  const [page, setPage] = useState<Page>('home')
  const [seed, setSeed] = useState(nextSeed)
  const [savedGame, setSavedGame] = useState<GameState | null>(null)

  useEffect(() => {
    setSavedGame(loadUnfinishedGame()?.state ?? null)
  }, [page])

  const startGame = () => {
    setSavedGame(null)
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
    return <SichuanGame key={seed} seed={seed} restoredState={savedGame ?? undefined} onHome={() => setPage('home')} onNewGame={startGame} />

  return (
    <div className="home-page min-h-screen w-full relative">
      <ParticleBackground count={28} />
      <div className="container mx-auto py-8 px-4 relative z-10">
        <header className="home-hero">
          <div>
            <span className="eyebrow">麻将练习场 · 实战版</span>
            <h1>从牌效训练，到四方牌桌</h1>
            <p>完整体验成都血战到底：定缺、碰杠胡、三家 AI 对抗与逐笔结算。</p>
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
            {savedGame !== null && <button className="primary-action battle-start" onClick={continueGame}>继续牌局</button>}
            <button className="secondary-action battle-start" onClick={startGame}>开始新局</button>
          </div>
        </section>
        <section className="training-section">
          <div className="section-heading">
            <span className="eyebrow">专项训练</span>
            <h2>基本功训练</h2>
            <p>听牌、舍牌、速度与牌型训练仍可继续使用。</p>
          </div>
          <MajiangHand />
        </section>
      </div>
    </div>
  )
}

export default App
