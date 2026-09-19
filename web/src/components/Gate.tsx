import { useState, type FormEvent } from 'react'
import { api, type Role } from '../api.ts'

/** Passcode screen: an old school postcard fills the screen, with a mid-90s desktop login window in the middle.
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
    <div className="relative flex min-h-full items-end justify-center overflow-hidden bg-ink p-4 pb-8 sm:items-center sm:pb-4">
      {/* The whole postcard, uncropped. A blurred copy fills whatever space is left around it.
          On phones it sits at the top, above the login window. */}
      <img src="/hadassim-postcard.webp" alt="" className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl" />
      <img src="/hadassim-postcard.webp" alt="" className="absolute inset-0 h-full w-full object-contain object-top sm:object-center" />
      <div className="relative flex w-full max-w-md flex-col items-center gap-5">
        <h1 className="font-display -rotate-2 border-[3px] border-ink bg-sun px-4 py-1 text-3xl whitespace-nowrap shadow-chunk-lg sm:text-4xl">
          פגישת מחזור <span className="text-pink">2026</span>
        </h1>
        <div className="w-full">
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
