import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import { oneAtATime } from '../adminOnce.ts'

/** The pictures the server serves under /branding, by the fixed names it knows (server/branding.ts). */
const PICTURES = [
  { name: 'emblem.png', title: 'הסמל בכותרת', hint: 'ליד שם האתר בראש כל עמוד. PNG עם רקע שקוף נראה הכי טוב.', size: 'h-20' },
  { name: 'postcard.webp', title: 'הגלויה במסך הכניסה', hint: 'ברקע מסך הסיסמה, התמונה היחידה שרואים לפני שנכנסים.', size: 'h-40' },
  { name: 'favicon.png', title: 'האייקון בלשונית הדפדפן', hint: 'ריבוע קטן, למשל 64 על 64.', size: 'h-16' },
  { name: 'apple-touch-icon.png', title: 'האייקון במסך הבית', hint: 'כשמוסיפים את האתר למסך הבית בטלפון. ריבוע של 180 על 180.', size: 'h-20' },
] as const

type Notice = { name: string; text: string; error?: boolean }

/** Asks twice, inline, like the other destructive buttons on the admin pages. */
function RemoveButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  return armed ? (
    <span className="inline-flex gap-1">
      <button className="btn btn-pink btn-sm" onClick={() => (setArmed(false), onConfirm())}>
        להסיר באמת
      </button>
      <button className="btn btn-plain btn-sm" onClick={() => setArmed(false)}>
        ביטול
      </button>
    </span>
  ) : (
    <button className="btn btn-plain btn-sm" disabled={disabled} onClick={() => setArmed(true)}>
      הסרה
    </button>
  )
}

/** Organizers put the site's real emblem, postcard and icons in place here. They are kept on the server, not in the
 * code, and until one is uploaded the site shows a neutral placeholder. */
export default function Branding() {
  // Each address carries a version, so this page shows what the server has now rather than what the browser cached.
  const [loadedAt] = useState(() => Date.now())
  const [versions, setVersions] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [once] = useState(() => oneAtATime(() => {}))

  function act(name: string, action: () => Promise<unknown>, done: string) {
    return once(async () => {
      setBusy(name)
      setNotice(null)
      try {
        await action()
        setVersions((v) => ({ ...v, [name]: Date.now() }))
        setNotice({ name, text: done })
      } catch (err) {
        setNotice({ name, text: (err as Error).message, error: true })
      } finally {
        setBusy('')
      }
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="heading">מיתוג</h1>
        <Link to="/admin" className="btn btn-plain btn-sm">
          חזרה לחדר המנהל
        </Link>
      </div>
      <p>
        הסמל, הגלויה והאייקונים של האתר לא נשמרים בקוד שלו. תמונה שמעלים כאן נשמרת בשרת ומחליפה את התמונה הזמנית, והסרה מחזירה
        את התמונה הזמנית. דפדפנים שכבר הציגו את התמונה הקודמת עשויים להמשיך להציג אותה עד שעה.
      </p>
      <ul className="grid gap-4 sm:grid-cols-2">
        {PICTURES.map(({ name, title, hint, size }) => (
          <li key={name} className="chunk flex flex-col gap-3 p-5">
            <h2 className="font-display text-xl">{title}</h2>
            <img src={`/branding/${name}?v=${versions[name] ?? loadedAt}`} alt={title} className={`${size} w-fit max-w-full self-start rounded border-2 border-ink bg-paper object-contain`} />
            <p className="text-sm opacity-70">
              {hint} עד 5MB.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className={`btn btn-sm ${busy ? 'opacity-50' : 'cursor-pointer'}`}>
                {busy === name ? 'מעלים...' : 'החלפה'}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  disabled={busy !== ''}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    const body = new FormData()
                    body.set('file', file)
                    act(name, () => api(`/api/admin/branding/${name}`, { body }), 'התמונה הוחלפה.')
                  }}
                />
              </label>
              <RemoveButton
                disabled={busy !== ''}
                onConfirm={() => act(name, () => api(`/api/admin/branding/${name}`, { method: 'DELETE' }), 'הוסרה. מוצגת שוב התמונה הזמנית.')}
              />
            </div>
            {notice?.name === name && (
              <p role={notice.error ? 'alert' : 'status'} className={`rounded-lg border-[3px] border-ink p-2 font-bold ${notice.error ? 'bg-pink text-white' : 'bg-sun'}`}>
                {notice.text}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
