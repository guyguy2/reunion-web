import { useEffect, useState } from 'react'
import { api, type Credit } from '../api.ts'
import { useStore } from '../store.tsx'
import { RsvpChoice } from '../components/Rsvp.tsx'

function Countdown({ date }: { date: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const left = new Date(date).getTime() - now
  if (Number.isNaN(left)) return null
  if (left <= 0) return <div className="lcd inline-block text-3xl">המסיבה התחילה!</div>
  const parts = [
    ['ימים', Math.floor(left / 86_400_000)],
    ['שעות', Math.floor(left / 3_600_000) % 24],
    ['דקות', Math.floor(left / 60_000) % 60],
    ['שניות', Math.floor(left / 1000) % 60],
  ] as const
  return (
    // Styled after a pager display.
    <div className="inline-flex gap-3 rounded-xl border-[3px] border-ink bg-ink p-3 shadow-chunk" role="timer" aria-label="ספירה לאחור לפגישת המחזור">
      {parts.map(([label, value]) => (
        <div key={label} className="lcd min-w-16 text-center">
          <div className="text-4xl leading-none">{String(value).padStart(2, '0')}</div>
          <div className="text-base leading-none">{label}</div>
        </div>
      ))}
    </div>
  )
}

/** The Claude mark, drawn inline so it needs no asset and takes the size of the text beside it. */
function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" className="inline-block size-4 align-[-0.2em]" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={i} x="11.35" y="1.8" width="1.3" height="8.4" rx="0.65" fill="#d97757" transform={`rotate(${i * 30} 12 12)`} />
      ))}
    </svg>
  )
}

/**
 * Thanks to whoever helped build the site. Hidden from everyone else when the list is empty,
 * but always shown to the organizers, who edit it here rather than in the event details.
 */
export function Credits({ credits, isAdmin }: { credits: Credit[] | undefined; isAdmin: boolean }) {
  const [list, setList] = useState<Credit[]>(credits ?? [])
  const [draft, setDraft] = useState<Credit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(rows: Credit[]) {
    setBusy(true)
    setError(null)
    try {
      const saved = await api<{ credits: Credit[] }>('/api/admin/credits', { method: 'PUT', json: { credits: rows } })
      setList(saved.credits)
      setDraft(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin && !list.length) return null

  const edit = (i: number, field: keyof Credit, value: string) => setDraft((rows) => (rows ?? []).map((row, j) => (j === i ? { ...row, [field]: value } : row)))

  /** Swaps a row with its neighbour, so the list can be put in whatever order the organizers want. */
  const move = (i: number, by: -1 | 1) =>
    setDraft((rows) => {
      const next = [...(rows ?? [])]
      ;[next[i], next[i + by]] = [next[i + by], next[i]]
      return next
    })

  return (
    <section className="chunk bg-sun p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl">תודה ענקית</h2>
        {isAdmin && !draft && (
          <button className="btn btn-plain btn-sm" onClick={() => setDraft(list.length ? list : [{ name: '' }])}>
            עריכה
          </button>
        )}
      </div>
      <p className="mt-1 text-sm">
        תודה לכל מי שנבר בקלסרים, סרק תמונות ורדף אחרי אנשים בוואטסאפ. האתר הזה נבנה בהתנדבות ובאהבה <span aria-label="באהבה">❤️</span>, בעזרת{' '}
        <a className="font-bold underline decoration-2 underline-offset-2" href="https://claude.com/claude-code" target="_blank" rel="noreferrer">
          <ClaudeMark /> Claude Code
        </a>
      </p>

      {draft ? (
        <div className="mt-4 space-y-2">
          {draft.map((person, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input className="field flex-1" dir="auto" maxLength={60} value={person.name} onChange={(e) => edit(i, 'name', e.target.value)} placeholder="שם" aria-label="שם" />
              <input className="field flex-1" dir="auto" maxLength={120} value={person.note ?? ''} onChange={(e) => edit(i, 'note', e.target.value)} placeholder="מה הוא עשה (לא חובה)" aria-label="מה הוא עשה" />
              <button className="btn btn-plain btn-sm pixel" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`העלאת ${person.name || 'שורה'} למעלה`}>
                ↑
              </button>
              <button className="btn btn-plain btn-sm pixel" disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label={`הורדת ${person.name || 'שורה'} למטה`}>
                ↓
              </button>
              <button className="btn btn-plain btn-sm" onClick={() => setDraft(draft.filter((_, j) => j !== i))} aria-label={`הסרת ${person.name || 'שורה'}`}>
                הסרה
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="btn btn-plain btn-sm" onClick={() => setDraft([...draft, { name: '' }])}>
              הוספת שורה
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => save(draft.filter((row) => row.name.trim()))}>
              {busy ? 'שומרים...' : 'שמירה'}
            </button>
            <button className="btn btn-plain btn-sm" disabled={busy} onClick={() => (setDraft(null), setError(null))}>
              ביטול
            </button>
          </div>
          {error && (
            <p role="status" className="rounded-lg border-[3px] border-ink bg-pink p-2 text-sm font-bold text-white">
              {error}
            </p>
          )}
        </div>
      ) : list.length ? (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {list.map((person, i) => (
            <li key={i} className="rounded-lg border-[3px] border-ink bg-white p-2">
              <p className="font-bold" dir="auto">
                {person.name}
              </p>
              {person.note && (
                <p className="text-sm" dir="auto">
                  {person.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm font-bold">עוד לא הודינו לאף אחד. לחצו על "עריכה" כדי להוסיף שמות.</p>
      )}

      <p className="mt-4 text-sm">שכחנו מישהו? משהו לא עובד? כפתור "משוב" למעלה מגיע ישר אלינו.</p>
    </section>
  )
}

export default function EventPage() {
  const { event, people, role } = useStore()
  if (!event) return null
  const date = new Date(event.date)
  const coming = people.filter((p) => p.attending === 'yes').length

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 sm:p-8">
      <header className="space-y-3">
        <h1 className="heading" dir="auto">
          {event.title}
        </h1>
        <p className="marker text-2xl" dir="auto">
          {event.tagline}
        </p>
        <Countdown date={event.date} />
      </header>

      <RsvpChoice />

      <div className="grid gap-6 sm:grid-cols-2">
        <section className="chunk p-5">
          <h2 className="label">מתי</h2>
          <p className="text-xl font-bold">
            {Number.isNaN(date.getTime())
              ? 'התאריך יפורסם בהמשך'
              : date.toLocaleString('he-IL', { dateStyle: 'full', timeStyle: 'short' })}
          </p>
          <h2 className="label mt-4">איפה</h2>
          <p className="text-xl font-bold" dir="auto">
            {event.venue.name}
          </p>
          <p dir="auto">{event.venue.address}</p>
          {event.venue.mapUrl && (
            <a className="btn btn-teal btn-sm mt-3" href={event.venue.mapUrl} target="_blank" rel="noreferrer">
              פתיחת מפה
            </a>
          )}
        </section>
        <section className="chunk bg-pink p-5 text-white">
          <h2 className="label">על מה מדובר</h2>
          <p className="text-lg" dir="auto">
            {event.about}
          </p>
          {coming > 0 && <p className="marker mt-3 text-xl">{coming} כבר אישרו הגעה.</p>}
        </section>
      </div>

      {event.schedule.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-2xl">לוח הזמנים של הערב</h2>
          {/* TV-guide grid */}
          <div className="chunk overflow-hidden">
            {event.schedule.map((slot, i) => (
              <div key={i} className={`grid grid-cols-[6.5rem_1fr] ${i ? 'border-t-[3px] border-ink' : ''}`}>
                <div className="pixel flex items-center justify-center border-e-[3px] border-ink bg-grape p-2 text-2xl text-white">{slot.time}</div>
                <div className={`p-3 ${i % 2 ? 'bg-paper' : 'bg-white'}`}>
                  <p className="font-bold" dir="auto">
                    {slot.title}
                  </p>
                  <p className="text-sm" dir="auto">
                    {slot.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <Credits credits={event.credits} isAdmin={role === 'admin'} />

      <footer className="flex items-center justify-center gap-3 pb-6 text-sm">
        <span>מספר המבקרים עד כה:</span>
        <span className="lcd text-2xl tracking-widest">{String(event.visits).padStart(6, '0')}</span>
      </footer>
    </div>
  )
}
