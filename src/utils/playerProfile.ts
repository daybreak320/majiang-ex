export type TrainingType = '实战训练' | '听牌训练' | '出牌训练' | '速度挑战' | '牌型识别' | string

export interface PlayerTrainingProfile {
  playerId: string
  trainingCounts: Record<string, number>
  lastTrainingAt: string | null
  lastTrainingType: string | null
  specialTrainingNextIndex: Partial<Record<string, number>>
  specialTrainingCompleted: Partial<Record<string, number>>
}

const PLAYER_PROFILE_KEY = 'mj_player_training_profile'

export function loadPlayerTrainingProfile(): PlayerTrainingProfile | null {
  try {
    const saved = localStorage.getItem(PLAYER_PROFILE_KEY)
    if (!saved)
      return null

    const profile = JSON.parse(saved) as Partial<PlayerTrainingProfile>
    if (typeof profile.playerId !== 'string' || !profile.playerId.trim())
      return null

    return {
      playerId: profile.playerId.trim(),
      trainingCounts: profile.trainingCounts ?? {},
      lastTrainingAt: profile.lastTrainingAt ?? null,
      lastTrainingType: profile.lastTrainingType ?? null,
      specialTrainingNextIndex: profile.specialTrainingNextIndex ?? {},
      specialTrainingCompleted: profile.specialTrainingCompleted ?? {},
    }
  }
  catch {
    return null
  }
}

export function savePlayerId(playerId: string): PlayerTrainingProfile {
  const existing = loadPlayerTrainingProfile()
  const profile: PlayerTrainingProfile = {
    playerId: playerId.trim(),
    trainingCounts: existing?.trainingCounts ?? {},
    lastTrainingAt: existing?.lastTrainingAt ?? null,
    lastTrainingType: existing?.lastTrainingType ?? null,
    specialTrainingNextIndex: existing?.specialTrainingNextIndex ?? {},
    specialTrainingCompleted: existing?.specialTrainingCompleted ?? {},
  }
  localStorage.setItem(PLAYER_PROFILE_KEY, JSON.stringify(profile))
  return profile
}

export function takeNextSpecialTrainingIndex(trainingType: string, librarySize: number): number | null {
  const profile = loadPlayerTrainingProfile()
  if (profile === null || librarySize <= 0)
    return null
  const current = profile.specialTrainingNextIndex[trainingType] ?? 0
  const index = current % librarySize
  const next: PlayerTrainingProfile = {
    ...profile,
    specialTrainingNextIndex: {
      ...profile.specialTrainingNextIndex,
      [trainingType]: (index + 1) % librarySize,
    },
  }
  localStorage.setItem(PLAYER_PROFILE_KEY, JSON.stringify(next))
  return index
}

export function recordSpecialTrainingCompleted(trainingType: string): PlayerTrainingProfile | null {
  const profile = loadPlayerTrainingProfile()
  if (profile === null)
    return null
  const next: PlayerTrainingProfile = {
    ...profile,
    specialTrainingCompleted: {
      ...profile.specialTrainingCompleted,
      [trainingType]: (profile.specialTrainingCompleted[trainingType] ?? 0) + 1,
    },
  }
  localStorage.setItem(PLAYER_PROFILE_KEY, JSON.stringify(next))
  return next
}

export function recordTrainingStart(trainingType: TrainingType): PlayerTrainingProfile | null {
  const profile = loadPlayerTrainingProfile()
  if (profile === null)
    return null

  const next: PlayerTrainingProfile = {
    ...profile,
    trainingCounts: {
      ...profile.trainingCounts,
      [trainingType]: (profile.trainingCounts[trainingType] ?? 0) + 1,
    },
    lastTrainingType: trainingType,
    lastTrainingAt: new Date().toISOString(),
  }
  localStorage.setItem(PLAYER_PROFILE_KEY, JSON.stringify(next))
  return next
}
