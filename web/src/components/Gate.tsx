import { useState, type FormEvent } from 'react'
import { api, type Role } from '../api.ts'

/** Passcode screen, dressed up as a mid-90s desktop login window. */
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
      <div className="w-full max-w-md">
        <h1 className="heading mb-6 text-center">Class Reunion</h1>
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
            <p className="marker text-lg">Classmates only. What's the secret passcode?</p>
            <div>
              <label className="label" htmlFor="passcode">
                Passcode
              </label>
              <input
                id="passcode"
                className="field"
                type="password"
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
              {busy ? 'Dialing in...' : 'Let me in'}
            </button>
            <p className="text-sm opacity-70">The passcode was in your invitation. Lost it? Ask one of the organizers.</p>
          </div>
        </form>
      </div>
    </div>
  )
}
