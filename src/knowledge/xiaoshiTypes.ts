// 破晓哥实战决策库 · 类型定义（v0.1 骨架）
// 定位：把川麻博主「破晓哥」（破晓哥，概率统计流派）的实战决策
//       沉淀为可机读的 决策卡(case) + 规则(rule)，供训练/复盘引擎调用。
// 说明：本模块为「风格镜像」启发式库，与破晓哥理论(mahjongTheory.ts)并存对照，
//       不构成唯一真理。原话字段忠实保留，具体牌张决策以人工核对为准。

/** 座次；'桌面' 表示该张已出现在公共牌河但归属不明确（仍是有用信息） */
export type Seat = '上家' | '对家' | '下家' | '自己' | '桌面'

/** 牌面标签：数字(1-9) + 花色，如 '3筒'、'6条'、'9万' */
export type TileLabel = `${number}${'万' | '条' | '筒'}`

/** 决策主题（取自主题地图 v1 的 8 簇子集，单卡聚焦其一） */
export type DecisionTheme =
  | '期望与进攻'
  | '防守与逃跑'
  | '形势与信息'
  | '对子搭子与牌效率'
  | '找叫与选叫'
  | '单钓七对与特殊牌型'
  | '整局实战与复盘'
  | '心态与理念'

/** 牌河关键信息：他打过的牌是最便宜的情报 */
export interface RiverKeyInfo {
  tile: TileLabel
  by: Seat
  note?: string
}

/** 局面快照：口播摘要 + 关键牌河（不逐张复刻手牌，宁缺毋滥） */
export interface XiaoshiSituation {
  summary: string
  riverKey?: RiverKeyInfo[]
}

export type XiaoshiActionType =
  | 'pong'            // 碰
  | 'decline_pong'    // 不碰
  | 'kang'            // 杠
  | 'decline_kang'    // 不杠
  | 'discard'         // 舍牌
  | 'decline_hu'      // 不胡/弃胡（放一手等自摸）
  | 'hu'              // 点炮胡/自摸胡（走牌）
  | 'observation'     // 复盘观察（非单点决策）
  | 'other'

export interface XiaoshiAction {
  type: XiaoshiActionType
  detail: string
}

/** 决策卡：局面 → 行动 → 理由原话（三件套） */
export interface DecisionCase {
  id: string                    // 形如 cas_001_d1
  theme: DecisionTheme
  timestamp: readonly [number, number]  // 视频内 [起, 止] 秒
  situation: XiaoshiSituation
  action: XiaoshiAction
  /** 理由必须保留口播原话（校正同音错字后逐字保留） */
  reasonQuotes: readonly string[]
  /** 边界条件：'如果是 X 我就 Y'——规则适用边界，最值钱 */
  boundary?: string | null
  outcome?: string | null       // 结果验证，如 '六筒自摸 净收8分'
  /** 0-1：口播完整+画面佐证 0.85-0.9；仅口播 0.7-0.8；推断性 ≤0.7 */
  confidence: number
  /** 对齐的破晓哥理论概念（下听/辐射/挨张…），暂无则 null */
  zhuyangAnchor?: string | null
  /** 学习态：用户冻结预测时的选择与分歧标签（学习库使用时填充） */
  learner?: { myChoice?: string; divergence?: string } | null
  /**
   * 素材出处（批量萃取卡专用）：可直接回看原片对应时间点复核。
   * 早期 12 期卡由 SOURCE_EPISODES 承载期级出处，此字段为 null。
   */
  source?: { videoId: string; title: string; t: number } | null
}

/** 归纳规则：可被训练引擎直接消费的最小单元 */
export interface XiaoshiRule {
  id: string                    // R-DROP-CALL-v0
  name: string
  /** 局面触发条件（自由文本，未来接结构化局面） */
  trigger: string
  action: string
  /** 核心理由（引用金句） */
  rationale: string
  boundary?: string | null
  /** 支撑证据：决策卡 id 列表 */
  evidence: readonly string[]
  /** 单期证据 ≤0.85；跨期 ≥3 期复现才升 0.9+ */
  confidence: number
  theme?: DecisionTheme
}

/** 牌面标签解析：'3筒' → { type:'tong', value:3 }，非法输入返回 null（供未来对接 game/types 的 Tile） */
export function parseTileLabel(label: string): { type: 'wan' | 'tiao' | 'tong'; value: number } | null {
  const m = /^([1-9])(万|条|筒)$/.exec(label.trim())
  if (!m) return null
  const typeMap: Record<'万' | '条' | '筒', 'wan' | 'tiao' | 'tong'> = { 万: 'wan', 条: 'tiao', 筒: 'tong' }
  return { type: typeMap[m[2] as '万' | '条' | '筒'], value: Number(m[1]) }
}

/** 合法性校验：牌面标签是否符合 TileLabel 格式 */
export function isTileLabel(value: string): value is TileLabel {
  return /^[1-9](万|条|筒)$/.test(value.trim())
}
