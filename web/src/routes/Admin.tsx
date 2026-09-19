import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, type FeedbackMessage } from '../api.ts'
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

/** Everything sent through the feedback button, newest first. Also emailed when email is set up. */
function FeedbackInbox() {
  const [messages, setMessages] = useState<FeedbackMessage[] | null>(null)
  const load = () => api<FeedbackMessage[]>('/api/admin/feedback').then(setMessages)

  useEffect(() => {
    load()
  }, [])

  return (
    <Section title={`משוב (${messages?.length ?? 0})`}>
      <ul className="max-h-96 space-y-2 overflow-y-auto">
        {messages?.map((m) => (
          <li key={m.id} className="space-y-1 rounded-lg border-[3px] border-ink p-3">
            <p className="whitespace-pre-wrap" dir="auto">
              {m.message}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm opacity-70">
              <span className="flex-1" dir="auto">
                {m.sender ?? 'ללא שם'}, {m.createdAt}
                {m.emailed ? '' : ' (לא נשלח במייל)'}
              </span>
              <ConfirmButton label="מחיקה" confirmLabel="למחוק" onConfirm={() => api(`/api/admin/feedback/${m.id}`, { method: 'DELETE' }).then(load)} />
            </div>
          </li>
        ))}
        {messages?.length === 0 && <li>עדיין אין משוב.</li>}
      </ul>
    </Section>
  )
}

/** Counts from GET /api/admin/stats. */
interface Stats {
  people: number
  claimed: number
  withPin: number
  withNowPhoto: number
  inMemoriam: number
  attending: { yes: number; maybe: number; no: number }
  faces: number
  facesNamed: number
  notes: number
  notesUnread: number
  feedback: number
  videos: number
  tapes: number
  quotes: number
  quoteComments: number
  visits: number
}

function StatTile({ label, value, detail, color = 'bg-white' }: { label: string; value: number | string; detail?: string; color?: string }) {
  return (
    <div className={`chunk p-3 ${color}`}>
      <p className="text-sm font-bold">{label}</p>
      <p className="font-display text-3xl leading-tight">{value}</p>
      {detail && <p className="text-xs opacity-70">{detail}</p>}
    </div>
  )
}

/** The numbers at a glance. Notes are shown as counts only; their content stays private. */
function Overview() {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    api<Stats>('/api/admin/stats').then(setStats)
  }, [])

  if (!stats) return <p className="pixel text-xl">טוען...</p>
  const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%')
  return (
    <Section title="סקירה">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        <StatTile label="בוגרים ברשימה" value={stats.people} detail={stats.inMemoriam ? `${stats.inMemoriam} ז״ל` : undefined} color="bg-sun" />
        <StatTile label="לקחו בעלות על פרופיל" value={stats.claimed} detail={`${pct(stats.claimed, stats.people)} מהרשימה`} />
        <StatTile label="בחרו קוד אישי" value={stats.withPin} detail={`מתוך ${stats.claimed} בעלי פרופיל`} />
        <StatTile label="העלו תמונה עדכנית" value={stats.withNowPhoto} />
        <StatTile label="מגיעים" value={stats.attending.yes} detail={`אולי ${stats.attending.maybe}, לא ${stats.attending.no}`} color="bg-teal text-white" />
        <StatTile label="פנים שזוהו" value={`${stats.facesNamed}/${stats.faces}`} detail={`${pct(stats.facesNamed, stats.faces)} מהפנים בתמונות`} />
        <StatTile label="פתקים שנשלחו" value={stats.notes} detail={`${stats.notesUnread} עוד לא נפתחו`} />
        <StatTile label="משוב" value={stats.feedback} />
        <StatTile label="סרטונים" value={stats.videos} />
        <StatTile label="קלטות" value={stats.tapes} />
        <StatTile label="ציטוטים" value={stats.quotes} detail={`${stats.quoteComments} תגובות`} />
        <StatTile label="כניסות לאתר" value={stats.visits} detail="מספר ההתחברויות עם סיסמה" />
      </div>
    </Section>
  )
}

/** A plain link: the browser saves the file itself, using the session cookie. */
function Backup() {
  return (
    <Section title="גיבוי">
      <div className="flex flex-wrap items-center gap-3">
        <a className="btn btn-sm" href="/api/admin/export" download>
          הורדת גיבוי
        </a>
        <p className="text-sm opacity-70">קובץ JSON עם כל הפרופילים, התמונות הקבוצתיות וכל תיוגי הפנים. בלי קבצי התמונות עצמם, בלי קודים אישיים ובלי פתקים.</p>
      </div>
    </Section>
  )
}

const TABS = [
  { id: 'overview', label: 'סקירה' },
  { id: 'people', label: 'אנשים' },
  { id: 'scenes', label: 'תמונות' },
] as const
type TabId = (typeof TABS)[number]['id']

export default function Admin() {
  const { scenes, people, reload } = useStore()
  const [taggingId, setTaggingId] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [csv, setCsv] = useState('')
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<TabId>('overview')
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

      <nav className="flex flex-wrap gap-2" aria-label="אזורי הניהול">
        {TABS.map((t) => (
          <button key={t.id} className={`btn btn-sm ${tab === t.id ? 'btn-pink' : 'btn-plain'}`} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <Overview />
          <Backup />
          <FeedbackInbox />
        </>
      )}

      {tab === 'scenes' && (
        <Section title="תמונות מחזור">
          {people.length === 0 && scenes.length === 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn btn-sm" disabled={busy === 'demo'} onClick={() => run('demo', () => api('/api/admin/demo', { method: 'POST' }).then(() => 'נתוני ההדגמה נטענו.'))}>
                {busy === 'demo' ? 'טוען...' : 'טעינת נתוני הדגמה'}
              </button>
              <p className="text-sm opacity-70">בוגרים ותמונות מדומים, להתנסות באתר.</p>
            </div>
          )}
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
      )}

      {tab === 'people' && (
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
              <p className="text-sm">השורה הראשונה היא כותרות. עמודות: name (חובה), former_name, nickname, email, instagram, linkedin, facebook, x, website, phone, city.</p>
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
      )}
    </div>
  )
}
