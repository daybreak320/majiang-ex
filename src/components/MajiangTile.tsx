import type { KeyboardEvent } from 'react'
import type { TileInstance } from '../game/types'
import type { Tile } from '../types'

interface MajiangTileProps {
  tile: Tile | TileInstance
  onClick?: () => void
  onDoubleClick?: () => void
  selected?: boolean
  correct?: boolean
  error?: boolean
  disabled?: boolean
  small?: boolean
}

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const

function ModernTileFace({ tile }: { tile: Tile | TileInstance }) {
  if (tile.type === '万') {
    return (
      <div className="modern-tile-symbol characters-symbol" aria-hidden="true">
        <strong>{CHINESE_NUMERALS[tile.value - 1]}</strong>
        <span>萬</span>
      </div>
    )
  }

  if (tile.type === '条') {
    return (
      <div className="modern-tile-symbol bamboo-symbol" aria-hidden="true">
        <strong>{tile.value}</strong>
        <span>条</span>
      </div>
    )
  }

  return (
    <div className="modern-tile-symbol dots-symbol" aria-hidden="true">
      <strong>{tile.value}</strong>
      <span>筒</span>
    </div>
  )
}

export function MajiangTile({
  tile,
  onClick,
  onDoubleClick,
  selected = false,
  correct = false,
  error = false,
  disabled = false,
  small = false,
}: MajiangTileProps) {
  const sizeClass = small ? 'w-10 h-14' : 'w-14 h-20'
  const stateClass = error
    ? 'error'
    : correct
      ? 'correct'
      : selected
        ? 'selected'
        : ''

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick || disabled)
      return

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick()
    }
  }

  return (
    <div
      className={`mahjong-tile modern-mahjong-tile ${small ? 'small-mahjong-tile' : ''} ${sizeClass} ${stateClass} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      onClick={disabled ? undefined : onClick}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      onKeyDown={handleKeyDown}
      role={onClick || onDoubleClick ? 'button' : undefined}
      tabIndex={(onClick || onDoubleClick) && !disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      aria-label={`${tile.value}${tile.type}`}
    >
      <div className="mahjong-tile-inner">
        <div className="tile-face">
          <ModernTileFace tile={tile} />
          {(selected || correct || error) && (
            <span
              className={`tile-badge ${
                error
                  ? 'tile-badge-error'
                  : correct
                    ? 'tile-badge-correct'
                    : 'tile-badge-selected'
              }`}
              aria-hidden="true"
            >
              {error ? '✕' : '✓'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
