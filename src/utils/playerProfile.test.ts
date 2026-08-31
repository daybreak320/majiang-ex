import { beforeEach, describe, expect, it } from 'vitest'
import { loadPlayerTrainingProfile, recordTrainingStart, savePlayerId } from './playerProfile'

describe('玩家训练轨迹', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    } as Storage
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
  })

  it('按名字 ID 汇总训练次数，不保存具体牌局', () => {
    expect(recordTrainingStart('实战训练')).toBeNull()

    savePlayerId('  破晓  ')
    recordTrainingStart('听牌训练')
    recordTrainingStart('听牌训练')
    recordTrainingStart('专项 · 残局 · 下宽叫')

    expect(loadPlayerTrainingProfile()).toEqual(expect.objectContaining({
      playerId: '破晓',
      trainingCounts: {
        '听牌训练': 2,
        '专项 · 残局 · 下宽叫': 1,
      },
      lastTrainingType: '专项 · 残局 · 下宽叫',
    }))
  })
})
