import { beforeEach, describe, expect, it } from 'vitest'
import { createInitialGame } from './core'
import { executeCommand } from './engine'
import { clearUnfinishedGame, GAME_SAVE_KEY, loadUnfinishedGame, saveUnfinishedGame } from './persistence'

describe('game persistence', () => {
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
    Object.defineProperty(globalThis, 'window', { value: { localStorage: store }, configurable: true })
  })

  it('serializes and restores a valid game state and event checkpoint', () => {
    const initial = createInitialGame(123)
    const result = executeCommand(initial, { type: 'dingque', playerId: 0, tileType: '万' })
    if (!result.ok)
      throw new Error(result.error)
    saveUnfinishedGame(result.nextState, { timedTraining: true })
    expect(loadUnfinishedGame()?.state).toEqual(result.nextState)
    expect(loadUnfinishedGame()?.stableEventSequence).toBe(result.nextState.events.length)
    expect(loadUnfinishedGame()?.options).toEqual({ timedTraining: true })
  })

  it('removes corrupt, incompatible, invalid or unstable saves', () => {
    window.localStorage.setItem(GAME_SAVE_KEY, '{bad json')
    expect(loadUnfinishedGame()).toBeNull()

    window.localStorage.setItem(GAME_SAVE_KEY, JSON.stringify({ schemaVersion: 999 }))
    expect(loadUnfinishedGame()).toBeNull()

    const state = createInitialGame(123)
    window.localStorage.setItem(GAME_SAVE_KEY, JSON.stringify({ schemaVersion: 1, state, stableEventSequence: 1, savedAt: Date.now() }))
    expect(loadUnfinishedGame()).toBeNull()

    const invalid = structuredClone(state)
    invalid.wall.pop()
    window.localStorage.setItem(GAME_SAVE_KEY, JSON.stringify({ schemaVersion: 1, state: invalid, stableEventSequence: 0, savedAt: Date.now() }))
    expect(loadUnfinishedGame()).toBeNull()
    expect(window.localStorage.getItem(GAME_SAVE_KEY)).toBeNull()
  })

  it('deletes a completed save', () => {
    const state = createInitialGame(456)
    saveUnfinishedGame(state)
    saveUnfinishedGame({ ...state, phase: 'finished' })
    clearUnfinishedGame()
    expect(loadUnfinishedGame()).toBeNull()
  })

  it('兼容没有会话设置的旧存档', () => {
    const state = createInitialGame(789)
    saveUnfinishedGame(state)
    expect(loadUnfinishedGame()?.options).toBeUndefined()
  })
})
