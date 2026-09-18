import { useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { createOSDAnnotator, type ImageAnnotation, type OpenSeadragonAnnotator } from '@annotorious/openseadragon'
import '@annotorious/openseadragon/annotorious-openseadragon.css'
import { api, faceUrl, matchesPerson, type Scene, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import { detectFaces } from '../detectFaces.ts'

function toAnnotation(tag: Tag): ImageAnnotation {
  const id = String(tag.id)
  return {
    id,
    bodies: [],
    target: {
      annotation: id,
      selector: {
        type: 'RECTANGLE',
        geometry: { x: tag.x, y: tag.y, w: tag.w, h: tag.h, bounds: { minX: tag.x, minY: tag.y, maxX: tag.x + tag.w, maxY: tag.y + tag.h } },
      },
    },
  } as ImageAnnotation
}

function boxOf(annotation: ImageAnnotation) {
  const { minX, minY, maxX, maxY } = annotation.target.selector.geometry.bounds
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Organizer tool: draw, move and delete face boxes, auto-detect faces, and put names on them. */
export default function Tagger({ scene, onClose }: { scene: Scene; onClose: () => void }) {
  const { people, personById, reload } = useStore()
  const host = useRef<HTMLDivElement>(null)
  const anno = useRef<OpenSeadragonAnnotator | null>(null)
  const owners = useRef(new Map<string, number | null>())
  const [drawing, setDrawing] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState('')

  const selected = scene.tags.find((t) => t.id === selectedId) ?? null
  const named = scene.tags.filter((t) => t.personId != null).length
  owners.current = new Map(scene.tags.map((t) => [String(t.id), t.personId]))

  useEffect(() => {
    const viewer = OpenSeadragon({
      element: host.current!,
      tileSources: scene.dzi,
      drawer: 'canvas',
      showNavigationControl: false,
      maxZoomPixelRatio: 5,
      gestureSettingsMouse: { clickToZoom: false },
    })
    const annotator = createOSDAnnotator(viewer, {
      drawingEnabled: false,
      style: (annotation) => {
        const isNamed = owners.current.get(annotation.id) != null
        return { stroke: isNamed ? '#14b8a6' : '#ec4899', strokeWidth: 2, fill: isNamed ? '#14b8a6' : '#ec4899', fillOpacity: 0.12 }
      },
    })
    annotator.setDrawingTool('rectangle')
    anno.current = annotator

    annotator.on('createAnnotation', async (annotation) => {
      const tag = await api<Tag>(`/api/admin/scenes/${scene.id}/tags`, { json: boxOf(annotation as ImageAnnotation) })
      await reload()
      setSelectedId(tag.id)
    })
    annotator.on('updateAnnotation', async (annotation) => {
      await api(`/api/admin/tags/${annotation.id}`, { method: 'PATCH', json: boxOf(annotation as ImageAnnotation) })
      await reload()
    })
    annotator.on('selectionChanged', (annotations) => {
      const id = Number(annotations[0]?.id)
      setSelectedId(Number.isFinite(id) && id > 0 ? id : null)
      setQuery('')
    })
    return () => {
      annotator.destroy()
      viewer.destroy()
      anno.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.dzi, scene.id])

  // The server is the source of truth; mirror its tags into the annotation layer after every reload.
  useEffect(() => {
    anno.current?.setAnnotations(scene.tags.map(toAnnotation), true)
  }, [scene.tags])

  useEffect(() => {
    anno.current?.setDrawingEnabled(drawing)
  }, [drawing])

  async function act(action: () => Promise<unknown>) {
    setMessage('')
    try {
      await action()
      await reload()
    } catch (err) {
      setMessage((err as Error).message)
    }
  }

  async function autoDetect() {
    setProgress(0)
    setMessage('')
    try {
      const boxes = await detectFaces(scene.dzi.replace(/scene\.dzi$/, 'scene.jpg'), scene.tags, setProgress)
      if (boxes.length) await api(`/api/admin/scenes/${scene.id}/tags/batch`, { json: { boxes } })
      await reload()
      setMessage(`נמצאו ${boxes.length} פנים חדשות. בדקו את התמונה ותקנו ידנית מה שפוספס.`)
    } catch (err) {
      setMessage(`זיהוי הפנים נכשל: ${(err as Error).message}`)
    } finally {
      setProgress(null)
    }
  }

  const matches = query.trim() ? people.filter((p) => matchesPerson(p, query)).slice(0, 6) : []
  const assign = (body: { personId: number | null }) => act(() => api(`/api/admin/tags/${selected!.id}`, { method: 'PATCH', json: body }))

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-paper sm:flex-row">
      <div className="relative min-h-0 flex-1 bg-ink">
        <div ref={host} dir="ltr" className="absolute inset-0" />
      </div>
      <aside className="max-h-[50%] w-full shrink-0 space-y-4 overflow-y-auto border-t-[3px] border-ink bg-white p-4 sm:max-h-none sm:w-80 sm:border-s-[3px] sm:border-t-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg leading-tight" dir="auto">
            {scene.title}
          </h2>
          <button className="btn btn-plain btn-sm" onClick={onClose}>
            סיום
          </button>
        </div>
        <p className="lcd text-lg">
          {scene.tags.length} פנים / {named} זוהו
        </p>

        <div className="grid grid-cols-2 gap-2">
          <button className={`btn btn-sm ${drawing ? 'btn-plain' : 'btn-teal'}`} onClick={() => setDrawing(false)}>
            הזזה / בחירה
          </button>
          <button className={`btn btn-sm ${drawing ? 'btn-pink' : 'btn-plain'}`} onClick={() => setDrawing(true)}>
            ציור מסגרות
          </button>
        </div>

        <div className="space-y-2">
          <button className="btn w-full" disabled={progress !== null} onClick={autoDetect}>
            {progress === null ? 'זיהוי פנים אוטומטי' : `סורק... ${Math.round(progress * 100)}%`}
          </button>
          <p className="text-xs opacity-70">רץ בדפדפן הזה. מוסיף מסגרת לכל פנים שעדיין אין להן מסגרת. אחר כך הבוגרים מוסיפים שמות.</p>
          <button
            className="btn btn-plain btn-sm w-full"
            disabled={progress !== null}
            onClick={() => act(() => api(`/api/admin/scenes/${scene.id}/unidentified-tags`, { method: 'DELETE' }))}
          >
            ניקוי כל המסגרות ללא שם
          </button>
        </div>
        {message && <p className="rounded-lg border-[3px] border-ink bg-sun p-2 text-sm font-bold">{message}</p>}

        {selected ? (
          <div className="space-y-3 border-t-[3px] border-ink pt-4">
            <div className="flex items-center gap-3">
              <img src={faceUrl(selected)} alt="" className="h-20 w-20 border-[3px] border-ink object-cover" />
              <p className="font-bold" dir="auto">
                {personById(selected.personId)?.name ?? 'עדיין בלי שם'}
              </p>
            </div>
            <input className="field" dir="auto" placeholder="הקלידו שם..." value={query} onChange={(e) => setQuery(e.target.value)} />
            {matches.map((p) => (
              <button key={p.id} dir="auto" className="btn btn-plain btn-sm w-full justify-start" onClick={() => (assign({ personId: p.id }), setQuery(''))}>
                {p.name}
              </button>
            ))}
            {query.trim().length > 1 && (
              <button
                className="btn btn-sm w-full"
                onClick={() =>
                  act(async () => {
                    const person = await api<{ id: number }>('/api/admin/people', { json: { name: query } })
                    await api(`/api/admin/tags/${selected.id}`, { method: 'PATCH', json: { personId: person.id } })
                    setQuery('')
                  })
                }
              >
                הוספת "{query.trim()}" כאדם חדש
              </button>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button className="btn btn-plain btn-sm" disabled={selected.personId == null} onClick={() => assign({ personId: null })}>
                הסרת השם
              </button>
              <button className="btn btn-plain btn-sm text-pink" onClick={() => act(() => api(`/api/admin/tags/${selected.id}`, { method: 'DELETE' })).then(() => setSelectedId(null))}>
                מחיקת המסגרת
              </button>
            </div>
          </div>
        ) : (
          <p className="border-t-[3px] border-ink pt-4 text-sm">בחרו מסגרת כדי לתת לה שם, להזיז או למחוק אותה. עברו ל"ציור מסגרות" כדי להוסיף פנים ידנית.</p>
        )}
      </aside>
    </div>
  )
}
