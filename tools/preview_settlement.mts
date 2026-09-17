/**
 * 生成「结算页 · 查叫关系」样式预览（用真实引擎跑出的局面，非手搓假数据）。
 * 用法：node_modules/.bin/vite-node tools/preview_settlement.mts
 * 产物：docs/结算页查叫解释预览.html
 */
import type { GameState, PlayerId } from '../src/game/types'
import { writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chooseAICommand } from '../src/game/ai'
import { createInitialGame } from '../src/game/core'
import { executeCommand } from '../src/game/engine'
import { buildSettlementSummary, FINAL_STATE_LABELS, PLAYER_NAMES } from '../src/game/presentation'

const PLAYER_IDS = [0, 1, 2, 3] as const

function play(seed: number): GameState {
  let state: GameState = createInitialGame(seed, ([1, 2, 3] as PlayerId[]).map(id => ({ name: `对手${id}`, aiStyle: 'steady' })))
  for (let step = 0; step < 8000; step++) {
    if (state.phase === 'finished')
      break
    let playerId: PlayerId | undefined
    if (state.phase === 'dingque')
      playerId = PLAYER_IDS.find(id => state.players[id].dingque === null)
    else if (state.phase === 'responding')
      playerId = state.responseWindow?.eligiblePlayers.find(id => state.responseWindow?.choices[id] === undefined)
    else
      playerId = state.currentPlayer
    if (playerId === undefined)
      break
    const cmd = chooseAICommand(state, playerId)
    if (cmd === null)
      break
    const res = executeCommand(state, cmd)
    if (!res.ok)
      break
    state = res.nextState
  }
  return state
}

interface Sample { seed: number, state: GameState, note: string, flows: number }

const buckets: Record<'flow' | 'silent' | 'allPig' | 'lone', Sample | null> = { flow: null, silent: null, allPig: null, lone: null }

for (let seed = 1; seed <= 160; seed++) {
  const state = play(seed)
  if (state.endReason !== 'wall_empty' && state.endReason !== 'three_winners')
    continue
  const summary = buildSettlementSummary(state)
  const flows = summary.readyTransfers.length
  const sample: Sample = { seed, state, note: summary.readyCheckNote, flows }
  if (flows > 0 && buckets.flow === null)
    buckets.flow = sample
  if (flows === 0 && buckets.silent === null && summary.readyCheckNote.includes('都没下叫'))
    buckets.silent = sample
  if (flows === 0 && buckets.allPig === null && summary.readyCheckNote.includes('全是花猪'))
    buckets.allPig = sample
  if (flows === 0 && buckets.lone === null && summary.readyCheckNote.includes('只剩 1 家未胡'))
    buckets.lone = sample
  if (Object.values(buckets).every(item => item !== null))
    break
}

function chipHtml(label: string, stateKey: string, text: string): string {
  return `<span class="ready-status ready-status-${stateKey}"><b>${label}</b><small>${text}</small></span>`
}

function cardHtml(caseTitle: string, hint: string, sample: Sample): string {
  const summary = buildSettlementSummary(sample.state)
  const chips = summary.players.map(p => chipHtml(
    PLAYER_NAMES[p.playerId],
    p.finalState,
    p.finalState === 'ready' && p.readyWaits.length > 0 ? `听 ${p.readyWaits.join('/')}` : FINAL_STATE_LABELS[p.finalState],
  )).join('\n          ')

  const body = summary.readyTransfers.length === 0
    ? `<p class="ready-note">${summary.readyCheckNote || '本局无查叫赔付。'}</p>`
    : `<div class="ready-relations">
            ${summary.readyTransfers.map(event => `<div>
              <span>${PLAYER_NAMES[event.from]}<small>未听</small></span>
              <strong>赔付 ${event.amount} 分</strong>
              <span>${PLAYER_NAMES[event.to]}<small>听牌方</small></span>
            </div>`).join('\n            ')}
          </div>`

  const finalBody = summary.finalTransfers.length === 0
    ? `<p class="ready-note">${summary.readyCheckNote || '本局终局无退税、无花猪赔付、无查叫赔付。'}</p>`
    : `<ol class="transfer-list">${summary.finalTransfers.map(event => `<li><span>#${event.sequence} ${PLAYER_NAMES[event.from]} → ${PLAYER_NAMES[event.to]}</span><strong>${event.amount} 分</strong></li>`).join('')}</ol>`

  return `<section class="case">
        <div class="case-head"><h2>${caseTitle}</h2><span>seed ${sample.seed} · ${sample.state.endReason === 'wall_empty' ? '牌墙摸完' : '三家已胡'} · 查叫流水 ${summary.readyTransfers.length} 笔</span></div>
        <p class="case-hint">${hint}</p>
        <div class="settlement-flow">
          <section class="settlement-card">
            <h3>终局结算</h3>
            ${finalBody}
          </section>
          <section class="settlement-card ready-settlement">
            <h3>查叫关系</h3>
            <div class="ready-status-row">
            ${chips}
            </div>
            ${body}
          </section>
        </div>
      </section>`
}

const order: [keyof typeof buckets, string, string][] = [
  ['flow', 'A · 正常查叫（有人听、有人没听）', '未听者按听牌方最高叫口赔付，流水照常出现在下方明细里。'],
  ['silent', 'B · 未胡几家都没下叫 → 没有叫口可收赔', '这正是你遇到的那种局：没人听牌，查叫无从发生，所以一分不扣。'],
  ['allPig', 'C · 未胡几家全是花猪 → 不产生查叫', '定缺没打完即为花猪，花猪既不能收赔、彼此之间也不查叫。'],
  ['lone', 'D · 只剩 1 家未胡 → 没有赔付对象', '其余三家都已胡，查叫失去对手方，本局不做查叫。'],
]

const casesHtml = order
  .filter(([key]) => buckets[key] !== null)
  .map(([key, title, hint]) => cardHtml(title, hint, buckets[key]!))
  .join('\n      ')

if (casesHtml === '')
  throw new Error('没有采到任何样本，请放宽 seed 范围')

const css = readFileSync(resolve('src/index.css'), 'utf8')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>结算页 · 查叫关系 样式预览</title>
<style>
body { margin: 0; padding: 2rem 1rem; background: #04120f; color: #e7f5f1; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; }
.wrap { max-width: 860px; margin: auto; }
.page-head h1 { margin: 0 0 .4rem; font-size: 1.6rem; }
.page-head p { margin: 0 0 2rem; color: #8eaaa3; font-size: .88rem; line-height: 1.6; }
.case { margin-bottom: 2.5rem; }
.case-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.case-head h2 { margin: 0; font-size: 1.05rem; color: #65e5c1; }
.case-head span { color: #7d9c95; font-size: .74rem; }
.case-hint { margin: .35rem 0 .8rem; color: #9dbab3; font-size: .84rem; line-height: 1.6; }
${css}
</style>
</head>
<body>
<div class="wrap">
  <div class="page-head">
    <h1>结算页 · 查叫关系</h1>
    <p>下线为真实引擎跑局结果（非手搓数据），只取四种典型终局，用来验收「为什么没有查叫扣分」的解释是否到位。上线产品的样式与本页完全一致。</p>
  </div>
  ${casesHtml}
</div>
</body>
</html>`

writeFileSync(resolve('docs/结算页查叫解释预览.html'), html)
console.log('WROTE docs/结算页查叫解释预览.html')
for (const [key, sample] of Object.entries(buckets))
  console.log(`  ${key}: ${sample === null ? '未采到' : `seed=${sample.seed} flows=${sample.flows} note=${sample.note}`}`)
