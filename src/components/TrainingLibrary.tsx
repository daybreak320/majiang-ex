import type { SpecialTrainingKind } from '../game/core'
import { SPECIAL_TRAINING_META } from '../game/core'

interface TrainingLibraryProps { onSelect: (kind: SpecialTrainingKind) => void }

export function TrainingLibrary({ onSelect }: TrainingLibraryProps) {
  return (
    <section className="training-library" aria-label="专项训练库">
      <div className="section-heading">
        <span className="eyebrow">专项训练库</span>
        <h2>把一个能力练透</h2>
        <p>完成作答后才会显示导师卡，实战局保持纯净决策。</p>
      </div>
      <div className="scenario-training-grid">
        {(Object.keys(SPECIAL_TRAINING_META) as SpecialTrainingKind[]).map(kind => (
          <button className="scenario-training-card" key={kind} onClick={() => onSelect(kind)}>
            <span className="scenario-training-category">专项训练</span>
            <h3>{SPECIAL_TRAINING_META[kind].title}</h3>
            <p>{SPECIAL_TRAINING_META[kind].summary}</p>
            <b>开始作答 →</b>
          </button>
        ))}
      </div>
    </section>
  )
}
