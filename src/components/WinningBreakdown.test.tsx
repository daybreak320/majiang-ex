import type { Tile, TileType } from '../types'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WinningBreakdown } from './WinningBreakdown'

const w = (values: number[], type: TileType = '万'): Tile[] => values.map(value => ({ type, value }))

describe('winningBreakdown · 龙七对身份牌渲染', () => {
  it ('清一色龙七对手牌：应亮明“龙七对”身份并解释四张折两对', () => {
    // 截图实测手牌：1万1万 2万×4 3万3万 4万4万 6万 9万9万，听 6万
    const hand = w([1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 6, 9, 9])
    const html = renderToString(<WinningBreakdown hand={hand} tingTiles={w([6])} />)
    expect(html).toContain('龙七对')
    expect(html).toContain('四张相同折两对')
  })

  it ('普通平胡不应误打龙七对标签', () => {
    // 123 456 789 万 + 1万1万 + 9万 单钓9万：标准胡、非七对
    const hand = w([1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 1, 9, 9])
    const html = renderToString(<WinningBreakdown hand={hand} tingTiles={w([9])} />)
    expect(html).not.toContain('龙七对')
  })
})
