import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Person } from '../api.ts'
import { useStore } from '../store.tsx'

/** Signing in to your own profile on this device with the personal code you chose. */
export default function CodeLogin({ person }: { person: Person }) {
  const { adoptToken, reload } = useStore()
  const navigate = useNavigate()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!person.hasPin) {
    return <p className="text-sm">לפרופיל הזה עדיין אין קוד אישי. אם הוא שלכם, פתחו את קישור העריכה ששמרתם או בקשו מהמארגנים לאפס אותו.</p>
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { token } = await api<{ token: string }>(`/api/people/${person.id}/login`, { json: { pin } })
      await adoptToken(token)
      await reload()
      navigate('/me')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="label" htmlFor={`pin-${person.id}`}>
        הקוד האישי של {person.name}
      </label>
      <div className="flex gap-2">
        <input
          id={`pin-${person.id}`}
          className="field"
          type="password"
          autoComplete="current-password"
          dir="ltr"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        <button className="btn btn-pink shrink-0" disabled={busy || pin.trim().length < 4}>
          כניסה
        </button>
      </div>
      {error && <p className="font-bold text-pink">{error}</p>}
    </form>
  )
}
