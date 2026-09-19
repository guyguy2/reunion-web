import { useState, type FormEvent } from 'react'
import { api, type Role } from '../api.ts'

/** Passcode screen: an old school postcard with a mid-90s desktop login window laid over its corner.
 * The postcard is a public file, the one picture shown before the passcode. */
export default function Gate({ onEnter }: { onEnter: (role: Role) => void }) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { role } = await api<{ role: Role }>('/api/login', { json: { passcode } })
      onEnter(role)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="flex w-full max-w-md flex-col items-center gap-6 lg:max-w-6xl lg:flex-row lg:gap-0">
        <figure className="w-full -rotate-2 border-[3px] border-ink bg-white p-2 shadow-chunk-lg sm:p-3 lg:w-auto lg:flex-1">
          <img src="/hadassim-postcard.webp" width={1400} height={972} alt="גלויה ישנה של הדסים: תלמידים בין הבניינים ועל הדשא" className="h-auto w-full" />
          <figcaption className="marker pt-2 text-center text-lg sm:text-xl">דרישת שלום מהדסים</figcaption>
        </figure>
        <div className="z-10 w-full max-w-md lg:-ms-20 lg:w-[26rem] lg:shrink-0 lg:rotate-1">
          <h1 className="heading mb-6 text-center">פגישת מחזור</h1>
          <form onSubmit={submit} className="chunk overflow-hidden shadow-chunk-lg">
            <div className="flex items-center justify-between border-b-[3px] border-ink bg-grape px-3 py-1.5 text-white">
              <span className="pixel text-xl">HALL_PASS.EXE</span>
              <span className="flex gap-1" aria-hidden>
                {['_', 'o', 'x'].map((ch) => (
                  <span key={ch} className="pixel flex h-5 w-5 items-center justify-center border-2 border-ink bg-paper text-ink">
                    {ch}
                  </span>
                ))}
              </span>
            </div>
            <div className="space-y-4 p-5">
              <p className="marker text-lg">לבוגרי המחזור בלבד. מה הסיסמה הסודית?</p>
              <div>
                <label className="label" htmlFor="passcode">
                  סיסמה
                </label>
                <input
                  id="passcode"
                  className="field"
                  type="password"
                  dir="ltr"
                  autoComplete="current-password"
                  autoFocus
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                />
              </div>
              {error && (
                <p role="alert" className="rounded-md border-[3px] border-ink bg-pink px-3 py-2 font-bold text-white">
                  {error}
                </p>
              )}
              <button className="btn btn-pink w-full" disabled={busy || !passcode}>
                {busy ? 'מתחברים...' : 'תנו לי להיכנס'}
              </button>
              <p className="text-sm opacity-70">הסיסמה נמצאת בהזמנה. אבדה? פנו לאחד המארגנים.</p>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
