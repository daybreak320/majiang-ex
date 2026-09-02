import type { TrainingTrend } from '../training/types'

export function TrendPanel({ trend }: { trend: TrainingTrend }) {
  return (
    <section className="trend-panel" aria-label="训练趋势">
      <div className="section-heading">
        <span className="eyebrow">长期趋势</span>
        <h3>你的决策变化</h3>
      </div>
      <div className="trend-meta" aria-label="趋势统计口径">
        <span>样本：{trend.games} 局 · {trend.decisions} 次决策</span>
        <span>时间窗：全部训练记录</span>
        <span>算法：{trend.algorithmVersion}</span>
      </div>
      {trend.ready
        ? (
            <div className="trend-dimensions">
              {trend.dimensions.map(item => (
                <div className="trend-dimension" key={item.key}>
                  <strong>{item.label}</strong>
                  <span className={`trend-${item.direction}`}>{item.direction === 'up' ? '↑ 提升' : item.direction === 'down' ? '↓ 下降' : '→ 稳定'}</span>
                  <small>
                    {item.sampleCount}
                    {' '}
                    次决策
                  </small>
                </div>
              ))}
            </div>
          )
        : <p className="trend-empty">数据积累中 · 至少完成 3 局且每维 5 次决策后展示方向</p>}
    </section>
  )
}
