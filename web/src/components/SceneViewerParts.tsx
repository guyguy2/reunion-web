import type { Tag } from '../api.ts'

// The class photo viewer's keyboard moves and its error message. Kept apart from SceneViewer.tsx, which loads
// OpenSeadragon and so can't be imported outside a browser.

type Box = Pick<Tag, 'id' | 'x' | 'y' | 'w' | 'h'>
export type Direction = 'left' | 'right' | 'up' | 'down'

const DIRECTIONS = new Map<string, Direction>([
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
])

/** Where an arrow key moves on the photo, left and right as on the picture itself. Null for any other key. */
export function faceDirection(key: string): Direction | null {
  return DIRECTIONS.get(key) ?? null
}

const center = (t: Box) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 })

/**
 * The nearest face in that direction: within 45 degrees of straight ahead, preferring the same row or column.
 * Null at the edge of the photo, so an arrow key never jumps to the far end of the next row.
 */
export function neighborFace<T extends Box>(tags: T[], from: Box, direction: Direction): T | null {
  const a = center(from)
  let best: T | null = null
  let bestScore = Infinity
  for (const tag of tags) {
    if (tag.id === from.id) continue
    const b = center(tag)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const ahead = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy
    const aside = Math.abs(direction === 'right' || direction === 'left' ? dy : dx)
    if (ahead <= 0 || aside > ahead) continue
    const score = ahead + 2 * aside
    if (score < bestScore) {
      best = tag
      bestScore = score
    }
  }
  return best
}

/** Where the keyboard enters the photo: the right end of the top row, where a Hebrew reader starts. */
export function firstFace<T extends Box>(tags: T[]): T | null {
  let face = tags.reduce<T | null>((top, t) => (top == null || center(t).y < center(top).y ? t : top), null)
  for (let next = face && neighborFace(tags, face, 'right'); next; next = neighborFace(tags, next, 'right')) face = next
  return face
}

/**
 * Whether a face got focus from the keyboard rather than a click. A browser too old to know `:focus-visible` throws;
 * then it counts as keyboard, since moving the picture to a clicked face does no harm.
 */
export function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

/** Over the viewer when the class photo could not be opened. */
export function SceneOpenFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="chunk space-y-3 p-6 text-center" role="alert">
        <p className="font-bold">התמונה לא נטענה. בדקו את החיבור ונסו שוב.</p>
        <button className="btn btn-pink" onClick={onRetry}>
          נסו שוב
        </button>
      </div>
    </div>
  )
}
