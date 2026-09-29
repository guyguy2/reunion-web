import { useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { faceUrl, type Scene, type Tag } from '../api.ts'
import { LAYER, useEscape } from '../useEscape.ts'
import { faceDirection, firstFace, neighborFace, SceneOpenFailed } from './SceneViewerParts.tsx'

interface Props {
  scene: Scene
  /** Name shown in the hover bubble; unidentified faces get a prompt instead. */
  labelFor: (tag: Tag) => string | null
  selectedTagId: number | null
  myPersonId: number | null
  /** Change `nonce` to fly to the tag again even if it is already selected. */
  focus: { tagId: number; nonce: number } | null
  onSelect: (tag: Tag) => void
  onBackgroundClick: () => void
}

/** Deep-zoom viewer for one scene, with a clickable overlay on every tagged face. */
export default function SceneViewer({ scene, labelFor, selectedTagId, myPersonId, focus, onSelect, onBackgroundClick }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewer = useRef<OpenSeadragon.Viewer | null>(null)
  const elements = useRef(new Map<number, HTMLElement>())
  const trackers = useRef<OpenSeadragon.MouseTracker[]>([])
  const handlers = useRef({ onSelect, onBackgroundClick })
  handlers.current = { onSelect, onBackgroundClick }
  const [openedDzi, setOpenedDzi] = useState<string | null>(null)
  const opened = openedDzi === scene.dzi
  const [failedDzi, setFailedDzi] = useState<string | null>(null)
  // The one face in the tab order. Arrow keys move between the faces, so Tab doesn't have to walk through all of them.
  const tabStop = useRef<number | null>(null)

  useEffect(() => {
    const osd = OpenSeadragon({
      element: host.current!,
      tileSources: scene.dzi,
      drawer: 'canvas',
      showNavigationControl: false,
      visibilityRatio: 0.6,
      minZoomImageRatio: 0.7,
      maxZoomPixelRatio: 4,
      animationTime: 0.9,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
      gestureSettingsTouch: { clickToZoom: false, dblClickToZoom: true },
    })
    viewer.current = osd
    osd.addHandler('open', () => setOpenedDzi(scene.dzi))
    osd.addHandler('open-failed', () => setFailedDzi(scene.dzi))
    osd.addHandler('canvas-click', (e) => {
      if (e.quick) handlers.current.onBackgroundClick()
    })
    return () => {
      trackers.current.forEach((t) => t.destroy())
      trackers.current = []
      elements.current.clear()
      viewer.current = null
      osd.destroy()
    }
  }, [scene.dzi])

  // (Re)build the face overlays whenever the tags or their labels change.
  useEffect(() => {
    const osd = viewer.current
    if (!osd || !opened) return
    trackers.current.forEach((t) => t.destroy())
    trackers.current = []
    elements.current.clear()
    osd.clearOverlays()
    tabStop.current = (scene.tags.find((t) => t.id === tabStop.current) ?? firstFace(scene.tags))?.id ?? null
    /** Moves the picture so a face reached by keyboard is on screen. */
    const showFace = (tag: Tag) => {
      const rect = osd.viewport.imageToViewportRectangle(tag.x, tag.y, tag.w, tag.h)
      const bounds = osd.viewport.getBounds()
      if (!bounds.containsPoint(rect.getTopLeft()) || !bounds.containsPoint(rect.getBottomRight())) osd.viewport.panTo(rect.getCenter())
    }
    for (const tag of scene.tags) {
      const el = document.createElement('div')
      el.className = `face-tag${tag.personId == null ? ' unknown' : ''}${tag.personId != null && tag.personId === myPersonId ? ' mine' : ''}`
      // Hover bubble: a magnified face, the name, and what a click will do.
      const name = labelFor(tag)
      el.tabIndex = tag.id === tabStop.current ? 0 : -1
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', name ?? 'מי בתמונה?')
      el.addEventListener('focus', () => {
        const previous = elements.current.get(tabStop.current ?? -1)
        if (previous) previous.tabIndex = -1
        tabStop.current = tag.id
        el.tabIndex = 0
        if (!el.matches(':focus-visible')) return
        // Tabbing to a face off screen scrolls the viewer's own boxes; put them back and move the picture instead.
        for (const box of [osd.container, osd.canvas]) box.scrollTop = box.scrollLeft = 0
        showFace(tag)
      })
      // Enter or Space does what a click does; the arrow keys go to the next face that way. Handled keys stop here,
      // so the viewer doesn't also pan. Escape and browser shortcuts (like Alt+Left for back) go on as usual.
      el.addEventListener('keydown', (e) => {
        const direction = faceDirection(e.key)
        if ((e.key !== 'Enter' && e.key !== ' ' && !direction) || e.altKey || e.ctrlKey || e.metaKey) return
        e.preventDefault()
        e.stopPropagation()
        if (!direction) return handlers.current.onSelect(tag)
        const next = neighborFace(scene.tags, tag, direction)
        if (next) elements.current.get(next.id)?.focus({ preventScroll: true })
      })
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.dir = 'rtl'
      const face = document.createElement('img')
      face.alt = ''
      const title = document.createElement('strong')
      title.dir = 'auto'
      title.textContent = name ?? 'מי בתמונה?'
      const hint = document.createElement('span')
      hint.textContent = name ? 'לחצו לצפייה בפרופיל' : 'לחצו להוספת שם'
      bubble.append(face, title, hint)
      el.appendChild(bubble)
      el.addEventListener('mouseenter', () => {
        // Load the crop only when it is needed, and flip the bubble under the face near the top edge.
        if (!face.src) face.src = faceUrl(tag)
        const top = el.getBoundingClientRect().top - host.current!.getBoundingClientRect().top
        bubble.classList.toggle('below', top < 210)
      })
      osd.addOverlay({ element: el, location: osd.viewport.imageToViewportRectangle(tag.x, tag.y, tag.w, tag.h) })
      // MouseTracker tells a tap apart from the end of a drag, which a plain click listener cannot.
      trackers.current.push(
        new OpenSeadragon.MouseTracker({
          element: el,
          clickHandler: (e) => {
            if ((e as unknown as { quick: boolean }).quick) handlers.current.onSelect(tag)
          },
        }),
      )
      elements.current.set(tag.id, el)
    }
    // labelFor is recreated each render; the tags array identity is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, scene.tags, myPersonId])

  useEffect(() => {
    elements.current.forEach((el, id) => el.classList.toggle('selected', id === selectedTagId))
  }, [selectedTagId, opened, scene.tags])

  useEffect(() => {
    const osd = viewer.current
    const tag = focus && scene.tags.find((t) => t.id === focus.tagId)
    if (!osd || !opened || !tag) return
    // Frame the portrait with a few neighbors around it for context (and so small faces are not blown up too far).
    const rect = osd.viewport.imageToViewportRectangle(tag.x - tag.w * 3.5, tag.y - tag.h * 2, tag.w * 8, tag.h * 5)
    osd.viewport.fitBounds(rect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.tagId, focus?.nonce, opened])

  // Escape zooms back out, like the "all" button, once no window is open on top.
  useEscape(() => viewer.current?.viewport.goHome(), LAYER.picture)

  const zoom = (factor: number) => {
    const vp = viewer.current?.viewport
    if (!vp) return
    vp.zoomBy(factor)
    vp.applyConstraints()
  }

  const retry = () => {
    setFailedDzi(null)
    viewer.current?.open({ tileSource: scene.dzi })
  }

  return (
    <div className="absolute inset-0 bg-ink">
      {/* The viewer positions things by left/top, so it stays LTR inside the RTL page. */}
      <div ref={host} dir="ltr" className="absolute inset-0" />
      {failedDzi === scene.dzi && <SceneOpenFailed onRetry={retry} />}
      <div className="absolute end-3 bottom-20 flex flex-col gap-2 sm:bottom-4">
        <button className="btn btn-plain pixel h-11 w-11 p-0 text-2xl" onClick={() => zoom(1.6)} aria-label="הגדלה">
          +
        </button>
        <button className="btn btn-plain pixel h-11 w-11 p-0 text-2xl" onClick={() => zoom(1 / 1.6)} aria-label="הקטנה">
          -
        </button>
        <button className="btn btn-plain pixel h-11 w-11 p-0 text-lg" onClick={() => viewer.current?.viewport.goHome()} aria-label="הצגת התמונה כולה">
          הכל
        </button>
      </div>
    </div>
  )
}
