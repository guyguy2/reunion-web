import { useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { faceUrl, type Scene, type Tag } from '../api.ts'
import { LAYER, useEscape } from '../useEscape.ts'

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
    for (const tag of scene.tags) {
      const el = document.createElement('div')
      el.className = `face-tag${tag.personId == null ? ' unknown' : ''}${tag.personId != null && tag.personId === myPersonId ? ' mine' : ''}`
      // Hover bubble: a magnified face, the name, and what a click will do.
      const name = labelFor(tag)
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

  return (
    <div className="absolute inset-0 bg-ink">
      {/* The viewer positions things by left/top, so it stays LTR inside the RTL page. */}
      <div ref={host} dir="ltr" className="absolute inset-0" />
      <div className="pixel pointer-events-none absolute end-3 top-3 flex items-center gap-2 text-xl text-white drop-shadow">
        <span className="rec-dot inline-block h-3 w-3 rounded-full bg-red-500" /> REC
      </div>
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
