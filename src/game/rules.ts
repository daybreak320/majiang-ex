import type { TileType } from '../types'

export const MILESTONE_1_RULES = Object.freeze({
  version: 'm1.1',
  tileTypes: ['万', '条', '筒'] as const satisfies readonly TileType[],
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9] as const,
  copiesPerTile: 4,
  tileCount: 108,
  baseScore: 1,
  fanCap: 5,
  discardTimeoutSeconds: 15,
  responseTimeoutSeconds: 8,
})
