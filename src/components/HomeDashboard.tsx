import { calculateTrainingTrend } from '../training/trend'
import { TrendPanel } from './TrendPanel'

interface HomeDashboardProps { playerId: string, onStart: () => void, onEditPlayerId: () => void, onOpenLibrary: () => void }

export function HomeDashboard({ playerId, onStart, onEditPlayerId, onOpenLibrary }: HomeDashboardProps) {
  const trend = calculateTrainingTrend()
  return (
    <section className="home-dashboard" aria-label="训练总览">
      <div className="dashboard-next-step">
        <button className="player-id-highlight" onClick={onEditPlayerId} aria-label={playerId ? `编辑名字 ID：${playerId}` : '填写名字 ID'}>
          <span className="player-avatar" aria-hidden="true">🐼</span>
          <span><small>名字 ID</small><strong>{playerId || '填写名字 ID'}</strong></span>
          <b>{playerId ? '编辑' : '设置'}</b>
        </button>
        <span className="eyebrow">今日建议</span>
        <h2>{playerId ? `${playerId}，完成一局并复盘 2 个关键决策` : '先设置名字 ID，开始你的第一局'}</h2>
        <button className="primary-action" onClick={onStart}>{playerId ? '开始今日训练' : '设置并开始'}</button>
        <button className="secondary-action" onClick={onOpenLibrary}>浏览训练库</button>
      </div>
      <TrendPanel trend={trend} />
    </section>
  )
}
