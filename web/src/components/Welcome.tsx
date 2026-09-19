import { useEffect, useState } from 'react'
import type { Person } from '../api.ts'
import { useStore } from '../store.tsx'
import { LAYER, useEscape } from '../useEscape.ts'
import { daysLeft, RsvpChoice } from './Rsvp.tsx'

const SEEN_KEY = 'reunion.welcomed'

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'בוקר טוב'
  if (hour >= 12 && hour < 17) return 'צהריים טובים'
  if (hour >= 17 && hour < 22) return 'ערב טוב'
  return 'לילה טוב'
}

/** What to call someone: the nickname, else the first name. A poster name ("י. ישראלי") has no first name, so it stays whole. */
export function firstName(person: Pick<Person, 'name' | 'nickname'>): string {
  if (person.nickname) return person.nickname
  return /^\S\.\s/.test(person.name) ? person.name : person.name.split(/\s+/)[0]
}

const STATUS = { yes: 'אהיה שם!', maybe: 'אולי', no: 'לא אוכל להגיע' } as const

/** Once the site knows who you are: hello, where your RSVP stands, and how long until the reunion. Once per visit. */
export default function Welcome() {
  const { me, event } = useStore()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!me) return
    try {
      if (sessionStorage.getItem(SEEN_KEY) === String(me.id)) return
      sessionStorage.setItem(SEEN_KEY, String(me.id))
    } catch {
      /* private mode: greet anyway */
    }
    setOpen(true)
  }, [me?.id])

  const close = () => setOpen(false)
  useEscape(open && close, LAYER.dialog)
  if (!open || !me || !event) return null
  const when = new Date(event.date).getTime()
  const upcoming = !Number.isNaN(when) && when > Date.now()

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 sm:items-center sm:p-4" onClick={close}>
      <section className="chunk w-full space-y-4 rounded-b-none p-5 pb-8 shadow-chunk-lg sm:max-w-md sm:rounded-b-xl sm:pb-5" role="dialog" aria-labelledby="welcome-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="welcome-title" className="heading" dir="auto">
          {greeting(new Date().getHours())}, {firstName(me)}!
        </h2>
        {upcoming && (
          <p className="flex flex-wrap items-center gap-3 text-lg">
            <span>{event.title}</span>
            <span className="lcd text-2xl leading-none">{daysLeft(Math.floor((when - Date.now()) / 86_400_000))}</span>
          </p>
        )}
        <p className="text-lg">
          אישור ההגעה שלך: <strong>{me.attending ? STATUS[me.attending] : 'עוד לא ענית'}</strong>
        </p>
        {upcoming && <RsvpChoice />}
        <button className="btn btn-pink w-full" onClick={close} autoFocus>
          יאללה, פנימה
        </button>
      </section>
    </div>
  )
}
