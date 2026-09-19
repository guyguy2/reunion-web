import { useEffect, useRef } from 'react'

/** How far "up" a handler sits: a dialog closes before the drawer under it, which closes before the picture zooms out. */
export const LAYER = { picture: 0, drawer: 1, dialog: 2 } as const

type Entry = { layer: number; run: () => void }
const stack: Entry[] = []

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || stack.length === 0) return
  // Highest layer wins; within a layer, the most recently opened.
  const top = stack.reduce((best, entry) => (entry.layer >= best.layer ? entry : best))
  e.preventDefault()
  top.run()
}

/** Escape does the same as the window's X (or the picture's "all" button). One press closes only the top-most window. */
export function useEscape(handler: (() => void) | null | false, layer: number) {
  const latest = useRef(handler)
  latest.current = handler
  const active = Boolean(handler)

  useEffect(() => {
    if (!active) return
    const entry: Entry = { layer, run: () => latest.current && latest.current() }
    if (stack.length === 0) window.addEventListener('keydown', onKey)
    stack.push(entry)
    return () => {
      stack.splice(stack.indexOf(entry), 1)
      if (stack.length === 0) window.removeEventListener('keydown', onKey)
    }
  }, [active, layer])
}
