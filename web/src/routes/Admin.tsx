import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api.ts'
import { useStore } from '../store.tsx'
import Tagger from './Tagger.tsx'

/** Destructive actions ask twice, inline, instead of using a browser dialog. */
function ConfirmButton({ label, confirmLabel, onConfirm, className = '' }: { label: string; confirmLabel: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false)
  return armed ? (
    <span className="inline-flex gap-1">
      <button className="btn btn-pink btn-sm" onClick={() => (setArmed(false), onConfirm())}>
        {confirmLabel}
      </button>
      <button className="btn btn-plain btn-sm" onClick={() => setArmed(false)}>
        ביטול
      </button>
    </span>
  ) : (
    <button className={`btn btn-plain btn-sm ${className}`} onClick={() => setArmed(true)}>
      {label}
    </button>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="chunk space-y-4 p-5">
      <h2 className="font-display text-xl">{title}</h2>
      {children}
    </section>
  )
}

export default function Admin() {
  const { scenes, people, reload } = useStore()
  const [taggingId, setTaggingId] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [csv, setCsv] = useState('')
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState('')
  const [wipePhrase, setWipePhrase] = useState('')
  const tagging = scenes.find((s) => s.id === taggingId)

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(label)
    setNotice('')
    try {
      const result = await action()
      await reload()
      setNotice(result || 'בוצע.')
    } catch (err) {
      setNotice(`שגיאה: ${(err as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  function uploadScene(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const body = new FormData(form)
    run('scene', async () => {
      await api('/api/admin/scenes', { body })
      form.reset()
      return 'התמונה נוספה. פתחו את "תיוג פנים" כדי לזהות פנים ולהוסיף שמות.'
    })
  }

  if (tagging) return <Tagger scene={tagging} onClose={() => setTaggingId(null)} />

  const shown = people.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <h1 className="heading">חדר המנהל</h1>
      {notice && (
        <p role="status" className="rounded-lg border-[3px] border-ink bg-sun p-3 font-bold">
          {notice}
        </p>
      )}

      <Section title="תמונות מחזור">
        <ul className="space-y-2">
          {scenes.map((scene) => (
            <li key={scene.id} className="flex flex-wrap items-center gap-2 rounded-lg border-[3px] border-ink p-2">
              <span className="min-w-0 flex-1 font-bold" dir="auto">
                {scene.title}
                <span className="ms-2 text-sm font-normal opacity-70">
                  {scene.width}x{scene.height}, {scene.tags.length} פנים, {scene.tags.filter((t) => t.personId != null).length} זוהו
                </span>
              </span>
              {scene.kind === 'group' && (
                <button className="btn btn-teal btn-sm" onClick={() => setTaggingId(scene.id)}>
                  תיוג פנים
                </button>
              )}
              <ConfirmButton label="מחיקה" confirmLabel="למחוק באמת" onConfirm={() => run('delete', () => api(`/api/admin/scenes/${scene.id}`, { method: 'DELETE' }).then(() => {}))} />
            </li>
          ))}
          {scenes.length === 0 && <li>עדיין אין תמונות.</li>}
        </ul>
        <form onSubmit={uploadScene} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="scene-title">
              כותרת (מופיעה בלשונית)
            </label>
            <input id="scene-title" name="title" className="field" dir="auto" placeholder="1996 - מחזור מ״ד" required maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="scene-image">
              תמונה (עד 40MB)
            </label>
            <input id="scene-image" name="image" type="file" accept="image/*" className="field" required />
          </div>
          <button className="btn btn-pink" disabled={busy === 'scene'}>
            {busy === 'scene' ? 'מפתחים...' : 'הוספת תמונה'}
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-3 border-t-[3px] border-ink pt-4">
          <button className="btn btn-sm" disabled={busy === 'wall'} onClick={() => run('wall', () => api('/api/admin/rebuild-wall', { method: 'POST' }).then(() => 'הקיר נבנה מחדש.'))}>
            {busy === 'wall' ? 'בונים...' : 'בנייה מחדש של הקיר'}
          </button>
          <p className="text-sm opacity-70">הקיר הוא לוח דיוקנאות שנוצר אוטומטית מכל מי שיש לו פרופיל. בנו אותו מחדש אחרי שינויים בשמות או בתמונות.</p>
        </div>
      </Section>

      <Section title={`אנשים (${people.length})`}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            run('person', async () => {
              await api('/api/admin/people', { json: { name: newName } })
              setNewName('')
            })
          }}
        >
          <input className="field" dir="auto" placeholder="הוספת שם לרשימה" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn shrink-0" disabled={newName.trim().length < 2}>
            הוספה
          </button>
        </form>

        <details>
          <summary className="cursor-pointer font-bold">ייבוא רשימה מקובץ CSV</summary>
          <div className="mt-3 space-y-2">
            <p className="text-sm">השורה הראשונה היא כותרות. עמודות: name (חובה), former_name, nickname, email, instagram, linkedin, city.</p>
            <textarea className="field pixel min-h-32 text-lg" dir="auto" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'name,former_name,city\n...'} />
            <button
              className="btn btn-sm"
              disabled={!csv.trim()}
              onClick={() =>
                run('csv', async () => {
                  const result = await api<{ added: number; skipped: string[] }>('/api/admin/import-csv', { body: csv })
                  setCsv('')
                  return `נוספו ${result.added}. ${result.skipped.length ? `דולגו: ${result.skipped.join('; ')}` : ''}`
                })
              }
            >
              ייבוא
            </button>
          </div>
        </details>

        <input className="field" type="search" dir="auto" placeholder="סינון" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ul className="max-h-96 divide-y-2 divide-ink/20 overflow-y-auto">
          {shown.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1" dir="auto">
                <span className="font-bold">{p.name}</span>
                <span className="ms-2 text-sm opacity-70">
                  {p.claimed ? 'בבעלות' : 'ללא בעלות'}
                  {p.email ? `, ${p.email}` : ''}
                </span>
              </span>
              <button
                className="btn btn-plain btn-sm"
                onClick={() => run('memoriam', () => api(`/api/admin/people/${p.id}`, { method: 'PATCH', json: { inMemoriam: !p.inMemoriam } }).then(() => {}))}
              >
                {p.inMemoriam ? 'ביטול סימון ז״ל' : 'סימון ז״ל'}
              </button>
              {p.claimed && (
                <ConfirmButton label="איפוס בעלות" confirmLabel="לאפס" onConfirm={() => run('reset', () => api(`/api/admin/people/${p.id}/reset-claim`, { method: 'POST' }).then(() => 'הבעלות אופסה. קישור העריכה הישן כבר לא עובד.'))} />
              )}
              <ConfirmButton label="מחיקה" confirmLabel="למחוק באמת" className="text-pink" onConfirm={() => run('delete', () => api(`/api/admin/people/${p.id}`, { method: 'DELETE' }).then(() => {}))} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="אזור מסוכן">
        {people.length === 0 && scenes.length === 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-sm" disabled={busy === 'demo'} onClick={() => run('demo', () => api('/api/admin/demo', { method: 'POST' }).then(() => 'נתוני ההדגמה נטענו.'))}>
              {busy === 'demo' ? 'טוען...' : 'טעינת נתוני הדגמה'}
            </button>
            <p className="text-sm opacity-70">בוגרים ותמונות מדומים, להתנסות באתר.</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input className="field max-w-xs" dir="ltr" placeholder='DELETE EVERYTHING' value={wipePhrase} onChange={(e) => setWipePhrase(e.target.value)} />
          <button
            className="btn btn-pink btn-sm"
            disabled={wipePhrase !== 'DELETE EVERYTHING'}
            onClick={() =>
              run('wipe', async () => {
                await api('/api/admin/wipe', { json: { confirm: wipePhrase } })
                setWipePhrase('')
                return 'הכל נמחק.'
              })
            }
          >
            מחיקת כל האנשים והתמונות (הקלידו DELETE EVERYTHING)
          </button>
        </div>
      </Section>
    </div>
  )
}
