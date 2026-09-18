import { useEffect, useState } from 'react'
import { useStore } from '../store.tsx'

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

export default function EventPage() {
  const { event, people } = useStore()
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

      <footer className="flex items-center justify-center gap-3 pb-6 text-sm">
        <span>מספר המבקרים עד כה:</span>
        <span className="lcd text-2xl tracking-widest">{String(event.visits).padStart(6, '0')}</span>
      </footer>
    </div>
  )
}
