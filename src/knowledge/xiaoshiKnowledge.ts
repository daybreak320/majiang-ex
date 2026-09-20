// 破晓哥实战决策库 · 合并检索池（统一入口）
// 把「破晓哥 216 卡」(xiaoshiCases.ts) 与「邂逅五合集 621 卡」(xiehouCases.ts)
// 合并为单一案例池，供导师面板 / 训练 / 复盘统一查询。
// 命名铁律：产品内统一以「破晓哥」呈现，内部 source 字段仅作原片溯源。

import type { DecisionCase, DecisionTheme } from './xiaoshiTypes'
import { XIAOSHI_CASES } from './xiaoshiCases'
import { XIEHOU_CASES } from './xiehouCases'

/** 全量决策卡：破晓哥 216 + 邂逅五合集 621 = 837 */
export const ALL_XIAOSHI_CASES: readonly DecisionCase[] = [
  ...XIAOSHI_CASES,
  ...XIEHOU_CASES,
]

/** 按 id 取单张（跨两库） */
export function getCaseById(id: string): DecisionCase | undefined {
  return ALL_XIAOSHI_CASES.find(c => c.id === id)
}

/** 按主题取案例子集（跨两库） */
export function getCasesByTheme(theme: DecisionTheme): DecisionCase[] {
  return ALL_XIAOSHI_CASES.filter(c => c.theme === theme)
}
