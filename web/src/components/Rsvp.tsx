import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { api, type Person } from '../api.ts'
import { useStore } from '../store.tsx'

const DAY = 86_400_000

export type RsvpShortcutState =
  | { kind: 'ask'; date: string | null }
  | { kind: 'going' | 'answered'; days: number | null }
  | { kind: 'over' }

/** What the header shows for the reunion: a request to RSVP until you answer yes or no, then a countdown. */
export function rsvpShortcut(attending: Person['attending'] | undefined, eventDate: string, now: number): RsvpShortcutState {
  const when = new Date(eventDate).getTime()
  if (when <= now) return { kind: 'over' }
  const days = Number.isNaN(when) ? null : Math.floor((when - now) / DAY)
  if (attending === 'yes') return { kind: 'going', days }
  if (attending === 'no') return { kind: 'answered', days }
  const date = Number.isNaN(when) ? null : new Date(when).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })
  return { kind: 'ask', date }
}

export function daysLeft(days: number | null): string {
  if (days === null) return 'האירוע'
  if (days === 0) return 'היום!'
  if (days === 1) return 'מחר!'
  return `עוד ${days} ימים`
}

/**
 * The link to the event page. "header" sits at the end of the desktop tab row; "bar" is the middle cell of the
 * phone's bottom bar. Both are loud while you haven't answered and turn into a quiet pager countdown once you have.
 */
export function RsvpShortcut({ variant }: { variant: 'header' | 'bar' }) {
  const { event, me } = useStore()
  if (!event) return null
  const state = rsvpShortcut(me?.attending, event.date, Date.now())

  if (variant === 'header') {
    return (
      <NavLink to="/event" className={state.kind === 'ask' ? 'btn py-1.5' : 'lcd flex items-center gap-2 text-xl leading-none whitespace-nowrap'}>
        {state.kind === 'ask' ? (
          <>
            אישור הגעה
            {state.date && <span className="pixel border-s-2 border-ink ps-2.5 text-xl leading-none font-normal">{state.date}</span>}
          </>
        ) : state.kind === 'over' ? (
          'האירוע'
        ) : (
          <>
            {state.kind === 'going' && <span className="font-sans text-sm font-bold">מגיעים!</span>}
            {daysLeft(state.days)}
          </>
        )}
      </NavLink>
    )
  }

  return (
    <NavLink
      to="/event"
      className={`-mt-2.5 flex-[1.35] rounded-t-lg border-x-[3px] border-t-[3px] border-ink px-1 pt-4 pb-3 text-center leading-none whitespace-nowrap sm:hidden ${
        state.kind === 'ask' ? 'bg-sun text-sm font-bold' : 'pixel bg-[#b9c7a0] text-lg text-[#1f2a17]'
      }`}
    >
      {state.kind === 'ask' ? 'אישור הגעה' : state.kind === 'over' ? 'האירוע' : daysLeft(state.days)}
    </NavLink>
  )
}

const CHOICES = [
  ['yes', 'אהיה שם'],
  ['maybe', 'אולי'],
  ['no', 'לא אוכל להגיע'],
] as const

/** The RSVP buttons on the event page. The answer is saved on your profile, so without one we send you to find it. */
export function RsvpChoice() {
  const { me, reload } = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!me) {
    return (
      <section className="chunk space-y-3 bg-sun p-5">
        <h2 className="font-display text-2xl">מגיעים?</h2>
        <p>אישור ההגעה נשמר בפרופיל שלכם. מצאו את עצמכם בספר המחזור או היכנסו לפרופיל, ואז חזרו לכאן.</p>
        <Link to="/me" className="btn btn-plain">
          לפרופיל שלי
        </Link>
      </section>
    )
  }

  async function choose(attending: 'yes' | 'maybe' | 'no') {
    setBusy(true)
    setError('')
    try {
      await api('/api/me', { method: 'PATCH', json: { attending } })
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="chunk space-y-3 bg-sun p-5">
      <h2 className="font-display text-2xl">מגיעים?</h2>
      <div className="flex flex-wrap gap-2">
        {CHOICES.map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={`btn btn-sm ${me.attending === value ? 'btn-pink' : 'btn-plain'}`}
            aria-pressed={me.attending === value}
            disabled={busy}
            onClick={() => choose(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="font-bold text-pink">{error}</p>}
    </section>
  )
}
