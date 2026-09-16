import type { MeldGroup, Tile } from '../types'
import { motion } from 'framer-motion'
import { analyzeTingPatterns, countQiDuiQuads } from '../utils/majiang'
import { MajiangTile } from './MajiangTile'

interface WinningBreakdownProps {
  hand: Tile[] // 13 张手牌
  tingTiles: Tile[] // 所有可胡的牌
}

const MELD_LABEL: Record<MeldGroup['kind'], string> = {
  pair: '将',
  sequence: '顺',
  triplet: '刻',
  qiduiPair: '对',
}

const MELD_STYLE: Record<MeldGroup['kind'], string> = {
  pair: 'border-yellow-400/50 bg-yellow-400/10',
  sequence: 'border-cyan-400/40 bg-cyan-400/10',
  triplet: 'border-purple-400/40 bg-purple-400/10',
  qiduiPair: 'border-pink-400/40 bg-pink-400/10',
}

// 一组牌（面子 / 搭子）的展示
function TileGroup({ tiles, label, style }: { tiles: Tile[], label: string, style: string }) {
  return (
    <div className={`flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg border ${style}`}>
      <div className="flex gap-1">
        {tiles.map((tile, i) => (
          <MajiangTile key={i} tile={tile} small />
        ))}
      </div>
      <span className="text-[11px] text-gray-400">{label}</span>
    </div>
  )
}

// 判断是否七对结构：固定面子全为「对」，且只差单张成牌
function isQiDuiPattern(p: { melds: MeldGroup[], wait: Tile[] }): boolean {
  return p.melds.length > 0
    && p.melds.every(m => m.kind === 'qiduiPair')
    && p.wait.length === 1
}

// 展示所有「固定面子 + 搭子 → 听 X、Y」的组合，让人直接看懂怎么胡
export function WinningBreakdown({ hand, tingTiles }: WinningBreakdownProps) {
  const patterns = analyzeTingPatterns(hand, tingTiles)
  if (patterns.length === 0)
    return null

  return (
    <div className="mt-3 space-y-3">
      {patterns.map((p, pi) => {
        // 七对结构：四张相同折两对 = 龙七对 / 双龙七对
        const fullTiles = [...p.melds.flatMap(m => m.tiles), ...p.wait, ...p.winsOn]
        const quads = countQiDuiQuads(fullTiles)
        const qiDui = isQiDuiPattern(p)
        const qiDuiLabel = quads >= 2 ? '双龙七对' : quads === 1 ? '龙七对' : '七对'
        return (
          <motion.div
            key={pi}
            className="p-3 bg-black/30 rounded-xl"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: pi * 0.06 }}
          >
            {qiDui && (
              <div className="mb-2">
                <span className="qidui-badge">{qiDuiLabel}</span>
                <span className="text-[11px] text-pink-200/80">· 不碰不杠，四张相同折两对算 7 个对子</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {/* 已成型的固定面子 */}
              {p.melds.map((m, mi) => (
                <TileGroup
                  key={`m-${mi}`}
                  tiles={m.tiles}
                  label={MELD_LABEL[m.kind]}
                  style={MELD_STYLE[m.kind]}
                />
              ))}

              {/* 搭子（缺一张的部分） */}
              {p.wait.length > 0 && (
                <>
                  <span className="text-gray-500 text-lg px-1">+</span>
                  <TileGroup
                    tiles={p.wait}
                    label="搭子"
                    style="border-orange-400/50 bg-orange-400/10 ring-1 ring-orange-400/30"
                  />
                </>
              )}

              {/* 听的牌 */}
              <span className="text-gray-400 text-sm px-1">听</span>
              <div className="flex gap-1">
                {p.winsOn.map((tile, ti) => (
                  <div key={ti} className="rounded ring-2 ring-green-400">
                    <MajiangTile tile={tile} small />
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}
