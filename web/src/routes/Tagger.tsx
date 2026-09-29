import { useCallback, useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { createOSDAnnotator, UserSelectAction, type ImageAnnotation, type OpenSeadragonAnnotator } from '@annotorious/openseadragon'
import '@annotorious/openseadragon/annotorious-openseadragon.css'
import { api, faceUrl, matchesPerson, type Scene, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import { detectFaces } from '../detectFaces.ts'
import { reloadFailedText, saveThenReload } from '../taggerSave.ts'

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
export default function Tagger({ scene: memberScene, onClose }: { scene: Scene; onClose: () => void }) {
  const { people, personById, reload } = useStore()
  // The store has the members' copy of the scene, which leaves out staff faces. The organizers' copy has them,
  // so they are drawn and auto-detect doesn't box them again.
  const [fullScene, setFullScene] = useState<Scene | null>(null)
  const [sceneFailed, setSceneFailed] = useState(false)
  const scene = fullScene ?? memberScene
  const host = useRef<HTMLDivElement>(null)
  const anno = useRef<OpenSeadragonAnnotator | null>(null)
  const owners = useRef(new Map<string, number | null>())
  const staffIds = useRef(new Set<string>())
  const tags = useRef(scene.tags)
  // The box just drawn, to be selected again once the reload has put it back on the canvas.
  const drawn = useRef<number | null>(null)
  // The save a box change started, so leaving can wait for it.
  const saving = useRef<Promise<unknown>>(Promise.resolve())
  const [drawing, setDrawing] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  // What to say when the reload after a change failed; empty when it didn't.
  const [reloadFailed, setReloadFailed] = useState('')

  const selected = scene.tags.find((t) => t.id === selectedId) ?? null
  const faces = scene.tags.filter((t) => !t.staff).length
  const named = scene.tags.filter((t) => t.personId != null).length
  owners.current = new Map(scene.tags.map((t) => [String(t.id), t.personId]))
  staffIds.current = new Set(scene.tags.filter((t) => t.staff).map((t) => String(t.id)))
  tags.current = scene.tags

  const loadScene = useCallback(async () => {
    const next = (await api<Scene[]>('/api/admin/scenes')).find((s) => s.id === memberScene.id)
    if (next) setFullScene(next)
  }, [memberScene.id])
  // After every change: this scene with its staff faces, and the store, for the people and the counts elsewhere.
  const refresh = () => Promise.all([loadScene(), reload()])

  // Also the retry after a failed first load.
  const openScene = useCallback(() => {
    setSceneFailed(false)
    loadScene().catch(() => setSceneFailed(true))
  }, [loadScene])
  useEffect(() => {
    openScene()
  }, [openScene])

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
      // Staff faces are drawn grey and can't be picked: they stay out of the yearbook and are handled in the roster tool.
      userSelectAction: (annotation) => (staffIds.current.has(annotation.id) ? UserSelectAction.NONE : UserSelectAction.EDIT),
      style: (annotation) => {
        if (staffIds.current.has(annotation.id)) return { stroke: '#9ca3af', strokeWidth: 2, fill: '#9ca3af', fillOpacity: 0.12 }
        const isNamed = owners.current.get(annotation.id) != null
        return { stroke: isNamed ? '#14b8a6' : '#ec4899', strokeWidth: 2, fill: isNamed ? '#14b8a6' : '#ec4899', fillOpacity: 0.12 }
      },
    })
    annotator.setDrawingTool('rectangle')
    anno.current = annotator

    // A box that fails to save is taken back off the canvas, so what's drawn is what the server has.
    const rollback = () => anno.current?.setAnnotations(tags.current.map(toAnnotation), true)
    annotator.on('createAnnotation', (annotation) =>
      act(async () => {
        const tag = await api<Tag>(`/api/admin/scenes/${scene.id}/tags`, { json: boxOf(annotation as ImageAnnotation) })
        drawn.current = tag.id
      }, rollback),
    )
    annotator.on('updateAnnotation', (annotation) => {
      // A box still being created has no server id yet; the reload after creating it redraws it.
      if (!owners.current.has(annotation.id)) return
      saving.current = act(() => api(`/api/admin/tags/${annotation.id}`, { method: 'PATCH', json: boxOf(annotation as ImageAnnotation) }), rollback)
    })
    annotator.on('selectionChanged', (annotations) => {
      const id = Number(annotations[0]?.id)
      setSelectedId(Number.isFinite(id) && id > 0 ? id : null)
      setQuery('')
    })
    return () => {
      // Leaving any other way (a header tab) can't wait, but the save is still sent: the change is reported on a timer.
      annotator.cancelSelected()
      annotator.destroy()
      viewer.destroy()
      anno.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.dzi, scene.id])

  // The server is the source of truth; mirror its tags into the annotation layer after every reload.
  useEffect(() => {
    anno.current?.setAnnotations(scene.tags.map(toAnnotation), true)
    // The redraw dropped the selection; select the new box again so its naming panel opens.
    if (drawn.current != null && scene.tags.some((t) => t.id === drawn.current)) {
      anno.current?.setSelected(String(drawn.current))
      drawn.current = null
    }
  }, [scene.tags])

  useEffect(() => {
    anno.current?.setDrawingEnabled(drawing)
  }, [drawing])

  async function act(action: () => Promise<unknown>, onError?: () => void) {
    setMessage('')
    setReloadFailed('')
    const result = await saveThenReload(action, refresh)
    // Only a failed save is undone. If just the reload failed, the server kept the change the canvas shows.
    if (result.status === 'not-saved') {
      setMessage(result.error)
      onError?.()
    }
    if (result.status === 'not-reloaded') setReloadFailed(reloadFailedText(true))
    return result.status
  }

  // A moved box is only saved once it is deselected, so deselect, wait for that save, and stay if it failed.
  async function finish() {
    saving.current = Promise.resolve()
    anno.current?.cancelSelected()
    // Annotorious reports the change after a 1 ms timer; this one is queued behind it.
    await new Promise((resolve) => setTimeout(resolve, 1))
    if ((await saving.current) !== 'not-saved') onClose()
  }

  function retryReload() {
    const text = reloadFailed
    setReloadFailed('')
    refresh().catch(() => setReloadFailed(text))
  }

  async function autoDetect() {
    setProgress(0)
    setMessage('')
    setReloadFailed('')
    try {
      const result = await saveThenReload(async () => {
        const boxes = await detectFaces(scene.dzi.replace(/scene\.dzi$/, 'scene.jpg'), scene.tags, setProgress)
        if (boxes.length) await api(`/api/admin/scenes/${scene.id}/tags/batch`, { json: { boxes } })
        return boxes.length
      }, refresh)
      if (result.status === 'not-saved') setMessage(`זיהוי הפנים נכשל: ${result.error}`)
      else setMessage(`נמצאו ${result.value} פנים חדשות. בדקו את התמונה ותקנו ידנית מה שפוספס.`)
      if (result.status === 'not-reloaded') setReloadFailed(reloadFailedText(result.value > 0))
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
          <button className="btn btn-plain btn-sm" onClick={finish}>
            סיום
          </button>
        </div>
        <p className="lcd text-lg">
          {faces} פנים / {named} זוהו
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
          <button className="btn w-full" disabled={progress !== null || !fullScene} onClick={autoDetect}>
            {progress === null ? 'זיהוי פנים אוטומטי' : `סורק... ${Math.round(progress * 100)}%`}
          </button>
          {sceneFailed && !fullScene && (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-sm font-bold text-pink">לא הצלחנו לטעון את פני הצוות בתמונה, ולכן הזיהוי האוטומטי כבוי.</p>
              <button className="btn btn-plain btn-sm shrink-0" onClick={openScene}>
                נסו שוב
              </button>
            </div>
          )}
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
        {reloadFailed && (
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-bold text-pink">{reloadFailed}</p>
            <button className="btn btn-plain btn-sm shrink-0" onClick={retryReload}>
              נסו שוב
            </button>
          </div>
        )}

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
