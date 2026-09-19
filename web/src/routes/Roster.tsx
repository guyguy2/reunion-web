import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, faceUrl, type Person, type Scene, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import { possibleDuplicates } from '../roster.ts'

const VIEWS = [
  { id: 'review', label: 'אחד אחד' },
  { id: 'duplicates', label: 'כפילויות' },
  { id: 'unnamed', label: 'בלי שם' },
  { id: 'staff', label: 'צוות' },
  { id: 'file', label: 'ייבוא וייצוא' },
] as const
type ViewId = (typeof VIEWS)[number]['id']

interface Face {
  scene: Scene
  tag: Tag
}

/** The face with the name printed under it, so a misread caption can be checked against the poster. */
function FaceCard({ face, children }: { face: Face; children?: ReactNode }) {
  return (
    <div className="flex w-32 shrink-0 flex-col gap-1 sm:w-36">
      <div className="polaroid pb-1 text-center">
        <img src={`${faceUrl(face.tag)}&caption`} alt="" className="aspect-[4/5] w-full object-cover" loading="lazy" />
        <span className="marker block pt-1 text-xs leading-tight" dir="auto">
          {[face.scene.year ?? face.scene.title, face.tag.classLabel].filter(Boolean).join(' · ')}
        </span>
        {face.tag.caption && (
          <span className="block truncate text-xs opacity-70" dir="auto">
            {face.tag.caption}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function ImportExport({ onDone }: { onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function upload(file: File) {
    setBusy(true)
    try {
      const r = await api<{ facesMatched: number; facesUnmatched: number; peopleAdded: number; peopleUpdated: number; namesKept: number }>('/api/admin/roster/import', { json: JSON.parse(await file.text()) })
      onDone(`${r.facesMatched} פנים עודכנו, ${r.peopleAdded} פרופילים נוספו, ${r.peopleUpdated} עודכנו. ${r.namesKept} שמות קיימים נשמרו, ${r.facesUnmatched} פנים מהקובץ לא נמצאו כאן.`)
    } catch (err) {
      onDone(`שגיאה: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm">
        הקובץ מכיל את השמות, הכיתות, בנים/בנות וסימוני הצוות של כל הפנים בתמונות המחזור. כך מעבירים רשימה שנבדקה במחשב אחד לאתר החי: מורידים כאן, ומעלים שם. הפנים מותאמות לפי התמונה והמיקום, שמות
        שכבר ניתנו באתר נשמרים, ואפשר להעלות שוב בלי ליצור כפילויות.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a className="btn btn-sm" href="/api/admin/roster/export" download>
          הורדת קובץ הרשימה
        </a>
        <label className={`btn btn-plain btn-sm ${busy ? 'opacity-50' : ''}`}>
          {busy ? 'מייבא...' : 'העלאת קובץ רשימה'}
          <input type="file" accept="application/json,.json" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
    </div>
  )
}

/** The organizers' tool for the names read off the posters: fix a name, say boy or girl, take the staff out, join or split people. */
export default function Roster() {
  const { people, reload } = useStore()
  const [scenes, setScenes] = useState<Scene[]>([])
  const [view, setView] = useState<ViewId>('review')
  const [onlyOpen, setOnlyOpen] = useState(true)
  const [index, setIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  // The queue is frozen while you work through it, so answering doesn't pull the next card out from under you.
  const [queue, setQueue] = useState<number[] | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setScenes((await api<Scene[]>('/api/admin/scenes')).filter((s) => s.kind === 'group'))
    await reload()
  }, [reload])
  useEffect(() => {
    load()
  }, [load])

  const facesOf = useMemo(() => {
    const map = new Map<number, Face[]>()
    for (const scene of scenes) for (const tag of scene.tags) if (tag.personId != null && !tag.staff) map.set(tag.personId, [...(map.get(tag.personId) ?? []), { scene, tag }])
    return map
  }, [scenes])
  const onPosters = useMemo(() => people.filter((p) => facesOf.has(p.id)), [people, facesOf])

  useEffect(() => {
    if (queue === null && onPosters.length) setQueue(onPosters.filter((p) => !onlyOpen || !p.gender).map((p) => p.id))
  }, [queue, onPosters, onlyOpen])

  const current = people.find((p) => p.id === queue?.[index])
  const run = async (action: () => Promise<unknown>, advance = false) => {
    setNotice('')
    try {
      await action()
      await load()
      if (advance) setIndex((i) => i + 1)
    } catch (err) {
      setNotice(`שגיאה: ${(err as Error).message}`)
    }
  }
  const patchPerson = (id: number, json: Partial<Person>) => api(`/api/admin/people/${id}`, { method: 'PATCH', json })
  const saveName = (p: Person) => {
    const name = nameRef.current?.value.trim()
    return name && name !== p.name ? patchPerson(p.id, { name }) : Promise.resolve()
  }
  // The split-off person is reviewed next.
  const splitOff = (tag: Tag) => async () => {
    const added = await api<Person>(`/api/admin/tags/${tag.id}/new-person`, { json: {} })
    setQueue((q) => q && [...q.slice(0, index + 1), added.id, ...q.slice(index + 1)])
  }
  const answer = (p: Person, gender: 'm' | 'f') => run(() => saveName(p).then(() => patchPerson(p.id, { gender })), true)

  // B for boy, G for girl, arrows to move. Not while typing a name.
  useEffect(() => {
    if (view !== 'review' || !current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      if (key === 'b' || key === 'נ') answer(current, 'm')
      else if (key === 'g' || key === 'ע') answer(current, 'f')
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.min(i + 1, queue?.length ?? 0))
      else if (e.key === 'ArrowRight') setIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const duplicates = useMemo(() => possibleDuplicates(onPosters, scenes).filter(([a, b]) => !dismissed.has(`${a.id}-${b.id}`)), [onPosters, scenes, dismissed])
  const staff = scenes.flatMap((scene) => scene.tags.filter((t) => t.staff).map((tag) => ({ scene, tag })))
  const unnamed = scenes.flatMap((scene) => scene.tags.filter((t) => !t.staff && t.personId == null).map((tag) => ({ scene, tag })))
  const counts: Record<ViewId, number | null> = { review: onPosters.filter((p) => !p.gender).length, duplicates: duplicates.length, unnamed: unnamed.length, staff: staff.length, file: null }

  return (
    <section className="chunk space-y-4 p-4 sm:p-5">
      <h2 className="font-display text-xl">רשימת הכיתות</h2>
      <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="כלי הרשימה">
        {VIEWS.map((v) => (
          <button key={v.id} className={`btn btn-sm shrink-0 ${view === v.id ? 'btn-teal' : 'btn-plain'}`} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
            {v.label}
            {counts[v.id] != null && ` (${counts[v.id]})`}
          </button>
        ))}
      </nav>
      {notice && (
        <p role="status" className="rounded-lg border-[3px] border-ink bg-sun p-3 font-bold">
          {notice}
        </p>
      )}

      {view === 'review' && (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" className="size-5" checked={onlyOpen} onChange={(e) => (setOnlyOpen(e.target.checked), setQueue(null), setIndex(0))} />
            רק מי שעוד לא סומן כבן או בת
          </label>
          {!current ? (
            <p className="rounded-lg border-[3px] border-ink bg-teal p-4 text-lg font-bold text-white">{queue?.length ? 'זהו, עברתם על כולם!' : 'אין את מי לבדוק כאן.'}</p>
          ) : (
            <div key={current.id} className="space-y-4">
              <p className="lcd inline-block text-lg">
                {index + 1}/{queue!.length}
              </p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {facesOf.get(current.id)?.map((face) => (
                  <FaceCard key={face.tag.id} face={face}>
                    {(facesOf.get(current.id)?.length ?? 0) > 1 && (
                      <button className="btn btn-plain btn-sm w-full px-1 text-xs" onClick={() => run(splitOff(face.tag))}>
                        זה מישהו אחר
                      </button>
                    )}
                  </FaceCard>
                ))}
              </div>
              <div>
                <label className="label" htmlFor="roster-name">
                  שם (אפשר להשלים שם פרטי)
                </label>
                <input
                  id="roster-name"
                  ref={nameRef}
                  className="field text-lg"
                  dir="auto"
                  defaultValue={current.name}
                  onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), run(() => saveName(current)))}
                  onBlur={() => run(() => saveName(current))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button className={`btn py-4 text-xl ${current.gender === 'f' ? 'btn-pink' : 'btn-plain'}`} onClick={() => answer(current, 'f')}>
                  בת
                </button>
                <button className={`btn py-4 text-xl ${current.gender === 'm' ? 'btn-teal' : 'btn-plain'}`} onClick={() => answer(current, 'm')}>
                  בן
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-plain btn-sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                  הקודם
                </button>
                <button className="btn btn-plain btn-sm" onClick={() => setIndex(index + 1)}>
                  דילוג
                </button>
                <button className="btn btn-plain btn-sm ms-auto" disabled={current.claimed} onClick={() => run(() => api(`/api/admin/people/${current.id}/staff`, { method: 'POST' }), true)}>
                  זה איש צוות, להסתיר
                </button>
              </div>
              <p className="hidden text-xs opacity-70 sm:block">מקלדת: G בת, B בן, חצים למעבר.</p>
            </div>
          )}
        </div>
      )}

      {view === 'duplicates' && (
        <ul className="space-y-3">
          {duplicates.length === 0 && <li>לא נמצאו שמות דומים בתמונות שונות.</li>}
          {duplicates.map(([a, b]) => (
            <li key={`${a.id}-${b.id}`} className="space-y-2 rounded-lg border-[3px] border-ink p-3">
              <div className="flex gap-3 overflow-x-auto pb-1">
                {[a, b].map((p) => (
                  <div key={p.id} className="space-y-1">
                    <p className="font-bold" dir="auto">
                      {p.name}
                    </p>
                    <div className="flex gap-2">{facesOf.get(p.id)?.map((face) => <FaceCard key={face.tag.id} face={face} />)}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {/* A claimed profile is the one that stays. */}
                <button className="btn btn-teal btn-sm" onClick={() => run(() => (a.claimed && !b.claimed ? api(`/api/admin/people/${b.id}/merge`, { json: { intoId: a.id } }) : api(`/api/admin/people/${a.id}/merge`, { json: { intoId: b.id } })))}>
                  אותו אדם, לאחד
                </button>
                <button className="btn btn-plain btn-sm" onClick={() => setDismissed(new Set(dismissed).add(`${a.id}-${b.id}`))}>
                  אנשים שונים
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {view === 'unnamed' && (
        <div className="space-y-3">
          <p className="text-sm">פנים בלי פרופיל: הכיתוב בפוסטר לא נקרא, או שהשם הוסר. כתבו שם כדי ליצור פרופיל.</p>
          <div className="flex flex-wrap gap-3">
            {unnamed.map((face) => (
              <FaceCard key={face.tag.id} face={face}>
                <form
                  className="space-y-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const name = new FormData(e.currentTarget).get('name')
                    run(() => api(`/api/admin/tags/${face.tag.id}/new-person`, { json: { name } }))
                  }}
                >
                  <input name="name" className="field px-2 py-1 text-sm" dir="auto" defaultValue={face.tag.caption ?? ''} placeholder="שם" required minLength={2} />
                  <button className="btn btn-sm w-full px-1 text-xs">יצירת פרופיל</button>
                </form>
                <button className="btn btn-plain btn-sm w-full px-1 text-xs" onClick={() => run(() => api(`/api/admin/tags/${face.tag.id}`, { method: 'PATCH', json: { staff: true } }))}>
                  צוות / לא פנים
                </button>
              </FaceCard>
            ))}
            {unnamed.length === 0 && <p>לכל הפנים יש פרופיל.</p>}
          </div>
        </div>
      )}

      {view === 'staff' && (
        <div className="space-y-3">
          <p className="text-sm">הפנים האלה מוסתרות מספר המחזור, מהחיפוש ומהספירות. תלמיד שהגיע לכאן בטעות? החזירו אותו.</p>
          <div className="flex flex-wrap gap-3">
            {staff.map((face) => (
              <FaceCard key={face.tag.id} face={face}>
                <button className="btn btn-plain btn-sm w-full px-1 text-xs" onClick={() => run(() => api(`/api/admin/tags/${face.tag.id}`, { method: 'PATCH', json: { staff: false } }))}>
                  זה תלמיד, להחזיר
                </button>
              </FaceCard>
            ))}
            {staff.length === 0 && <p>אף אחד לא סומן כצוות.</p>}
          </div>
        </div>
      )}

      {view === 'file' && <ImportExport onDone={(message) => (setNotice(message), setQueue(null), setIndex(0), load())} />}
    </section>
  )
}
