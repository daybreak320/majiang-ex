import { useState } from 'react'
import { loadMentorDialogues, recordMentorDialogue } from '../game/persistence'

export interface MentorKeyMoment {
  sequence: number
  title: string
  detail: string
  question: string
  topic: '牌效' | '攻防' | '鸣牌' | '专项'
}

const DEFAULT_QUESTIONS = [
  { label: '我刚才为什么要打这张？', topic: '牌效' as const },
  { label: '这手还有别的解释吗？', topic: '专项' as const },
  { label: '这里该优先进攻还是防守？', topic: '攻防' as const },
]

function answer(question: string, topic: MentorKeyMoment['topic'], keyMoments: MentorKeyMoment[], dialogueCount: number): string {
  const focused = keyMoments[0]
  const opening = focused === undefined
    ? '这局暂时没有被标为关键的可回溯节点。你可以直接描述想讨论的回合、手牌目标或对手动作，我会把问题保留下来。'
    : `先回到 #${focused.sequence}：${focused.title}。${focused.detail} 讨论时先区分当时已知的公开信息、可选路线，以及结果出现后才知道的信息。`
  const guidance = topic === '攻防'
    ? '接着比较继续推进的收益与放铳代价；不要仅凭结果倒推当时必须收手。'
    : topic === '鸣牌'
      ? '如果涉及碰牌，再核对副露后是否仍保留清晰进张与安全退路。'
      : topic === '牌效'
        ? '优先比较每条路线的真实有效进张，再判断是否值得为番型或猜测付出代价。'
        : '先说清当时想完成的目标，再检验这一步是否真的帮你接近它。'
  return `${opening} ${guidance} 这是第 ${dialogueCount + 1} 次讨论；你的问题“${question}”会作为下次复盘的追问线索。`
}

export function MentorGrowthPanel({ seed, keyMoments, onReplay }: { seed: number, keyMoments: MentorKeyMoment[], onReplay: (sequence: number) => void }) {
  const [question, setQuestion] = useState('')
  const [topic, setTopic] = useState<MentorKeyMoment['topic']>('牌效')
  const [response, setResponse] = useState('')
  const [dialogueCount, setDialogueCount] = useState(() => loadMentorDialogues().length)

  const ask = () => {
    const prompt = question.trim()
    if (!prompt)
      return
    const nextResponse = answer(prompt, topic, keyMoments, dialogueCount)
    recordMentorDialogue({ seed, prompt, response: nextResponse, topic, createdAt: Date.now() })
    setResponse(nextResponse)
    setDialogueCount(current => current + 1)
    setQuestion('')
  }

  const discussMoment = (moment: MentorKeyMoment) => {
    setTopic(moment.topic)
    setQuestion(moment.question)
    onReplay(moment.sequence)
  }

  return (
    <section className="mentor-growth-panel" aria-label="本局导师讨论">
      <div className="mentor-growth-heading">
        <div><span className="eyebrow">本局导师讨论</span><h2>从关键几手开始复盘</h2><p>讨论不预设结论。先回到当时的事件、牌河与可选路线，再判断这一步是否值得调整。</p></div>
        <strong>{dialogueCount} 次讨论</strong>
      </div>
      {keyMoments.length > 0 && (
        <div className="mentor-key-moments" aria-label="建议讨论的关键几手">
          <span>建议先讨论</span>
          <div>{keyMoments.map(moment => <button key={moment.sequence} onClick={() => discussMoment(moment)}><b>#{moment.sequence}</b>{moment.title}<small>{moment.detail}</small></button>)}</div>
        </div>
      )}
      <div className="mentor-growth-topics">
        {DEFAULT_QUESTIONS.map(item => <button key={item.label} className={topic === item.topic ? 'selected' : ''} onClick={() => { setTopic(item.topic); setQuestion(item.label) }}>{item.label}</button>)}
      </div>
      <div className="mentor-growth-input">
        <textarea value={question} maxLength={200} placeholder="例如：第 18 巡我为什么不该打这张？还有别的走法吗？" onChange={event => setQuestion(event.target.value)} />
        <button className="primary-action" onClick={ask} disabled={!question.trim()}>和导师讨论</button>
      </div>
      {response && <div className="mentor-growth-response"><b>导师回应</b><p>{response}</p></div>}
      <small className="mentor-growth-note">讨论记录会保留为个人复盘线索；导师只把它作为下一局提醒，不把任何个案当成固定口诀。</small>
    </section>
  )
}
