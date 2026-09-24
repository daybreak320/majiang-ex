// 导出实战数据：在浏览器运行时读取 localStorage（绕开 Chrome Snappy 压缩），
// 打包为 JSON 文件下载并尽量复制到剪贴板，供导师（破晓哥）做完整复盘画像。
// 仅浏览器环境使用；SSR / 测试环境调用 collectPracticeData 返回空对象。

const PRACTICE_KEYS: readonly string[] = [
  'majiang-ex:game-history',
  'majiang-ex:decision-events',
  'majiang-ex:review-feedback',
  'majiang-ex:mentor-dialogue',
  'xiaoshi:user-perspectives',
  'xiaoshi:distilled-experiences',
  'majiang-stats',
  'mj_player_training_profile',
]

export type PracticeValueKind = 'array' | 'object' | 'string' | 'null'

export interface PracticeExportKeyInfo {
  key: string
  present: boolean
  kind: PracticeValueKind
  count: number | null
}

export interface PracticeExportSummary {
  exportedAt: string
  keyCount: number
  presentCount: number
  totalBytes: number
  keys: PracticeExportKeyInfo[]
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

export function collectPracticeData(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof window === 'undefined' || !window.localStorage)
    return out
  for (const key of PRACTICE_KEYS) {
    const raw = window.localStorage.getItem(key)
    out[key] = raw === null ? null : safeParse(raw)
  }
  return out
}

function kindOf(value: unknown): PracticeValueKind {
  if (value === null || value === undefined)
    return 'null'
  if (Array.isArray(value))
    return 'array'
  if (typeof value === 'object')
    return 'object'
  return 'string'
}

function countOf(value: unknown): number | null {
  if (Array.isArray(value))
    return value.length
  if (value !== null && typeof value === 'object')
    return Object.keys(value as Record<string, unknown>).length
  return null
}

export function buildExportSummary(data: Record<string, unknown>): PracticeExportSummary {
  const keys: PracticeExportKeyInfo[] = PRACTICE_KEYS.map((key) => {
    const value = data[key]
    return { key, present: value !== null && value !== undefined, kind: kindOf(value), count: countOf(value) }
  })
  const presentCount = keys.filter(k => k.present).length
  const totalBytes = typeof Blob !== 'undefined'
    ? new Blob([JSON.stringify(data)]).size
    : JSON.stringify(data).length
  return {
    exportedAt: new Date().toISOString(),
    keyCount: PRACTICE_KEYS.length,
    presentCount,
    totalBytes,
    keys,
  }
}

function fileTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function exportPracticeData(): { summary: PracticeExportSummary, json: string } {
  const data = collectPracticeData()
  const summary = buildExportSummary(data)
  const payload = { app: 'majiang-ex', exportedAt: summary.exportedAt, data }
  const json = JSON.stringify(payload, null, 2)

  if (typeof document !== 'undefined') {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `majiang-practice-${fileTimestamp()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(json).catch(() => {})
  }

  return { summary, json }
}
