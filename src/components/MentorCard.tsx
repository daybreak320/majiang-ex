interface MentorCardProps {
  title: string
  message: string
  evidence?: string
  conclusion?: string
  nextStep?: string
}

/** Structured mentor explanation shown after a focused training answer. */
export function MentorCard({ title, message, evidence, conclusion, nextStep }: MentorCardProps) {
  return (
    <aside className="mentor-card" aria-label="导师建议">
      <span className="eyebrow">AI 导师</span>
      <h3>{title}</h3>
      {conclusion && <p><strong>结论：</strong>{conclusion}</p>}
      <p><strong>原因：</strong>{message}</p>
      {evidence && <p><strong>证据：</strong>{evidence}</p>}
      {nextStep && <p><strong>下一步：</strong>{nextStep}</p>}
    </aside>
  )
}
