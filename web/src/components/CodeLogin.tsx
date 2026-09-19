import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type Person } from '../api.ts'
import { useStore } from '../store.tsx'

/** What someone fills in when a profile becomes theirs: a personal code (required) and an email for a sign-in link if they forget it. */
export interface NewOwner {
  pin: string
  email: string
}

export const newOwnerReady = (owner: NewOwner) => owner.pin.trim().length >= 4

export function NewOwnerFields({ value, onChange }: { value: NewOwner; onChange: (value: NewOwner) => void }) {
  return (
    <div className="space-y-2">
      <div>
        <label className="label" htmlFor="new-pin">
          בחרו קוד אישי
        </label>
        <input
          id="new-pin"
          className="field"
          type="password"
          autoComplete="new-password"
          dir="ltr"
          value={value.pin}
          onChange={(e) => onChange({ ...value, pin: e.target.value })}
          placeholder="לפחות 4 תווים"
        />
        <p className="mt-1 text-xs opacity-70">איתו נכנסים לפרופיל מטלפון או ממחשב אחר.</p>
      </div>
      <div>
        <label className="label" htmlFor="new-email">
          אימייל (לא חובה)
        </label>
        <input id="new-email" className="field" type="email" dir="ltr" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} />
        <p className="mt-1 text-xs opacity-70">אם תשכחו את הקוד, נשלח לכאן קישור כניסה.</p>
      </div>
    </div>
  )
}

/** "Forgot my code": emails a one-time sign-in link to the address on the profile. */
function SignInLinkButton({ person }: { person: Person }) {
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function send() {
    setBusy(true)
    try {
      const { sentTo } = await api<{ sentTo: string }>(`/api/people/${person.id}/signin-link`, { method: 'POST' })
      setStatus({ kind: 'ok', text: `שלחנו קישור כניסה אל ${sentTo}. הוא עובד פעם אחת, במשך 30 דקות.` })
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-plain btn-sm" disabled={busy} onClick={send}>
        {busy ? 'שולחים...' : person.hasPin ? 'שכחתי את הקוד. שלחו לי קישור למייל' : 'שלחו לי קישור כניסה למייל'}
      </button>
      {status && (
        <p className={`text-sm font-bold ${status.kind === 'ok' ? 'text-teal' : 'text-pink'}`} dir="auto">
          {status.text}
        </p>
      )}
    </div>
  )
}

/** Opening the emailed link: trade it for a key on this device, then go to the profile. */
export function SignInFromLink() {
  const { token } = useParams()
  const { adoptToken, reload } = useStore()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    api<{ token: string }>('/api/signin', { json: { token } })
      .then(async ({ token: deviceToken }) => {
        await adoptToken(deviceToken)
        await reload()
        navigate('/me', { replace: true })
      })
      .catch((err) => setError((err as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="chunk space-y-3 p-6">
        {error ? (
          <>
            <p className="font-bold text-pink">{error}</p>
            <button className="btn" onClick={() => navigate('/me')}>
              לפרופיל שלי
            </button>
          </>
        ) : (
          <p className="pixel text-2xl">נכנסים...</p>
        )}
      </div>
    </div>
  )
}

/** Signing in to your own profile on this device with the personal code you chose. */
export default function CodeLogin({ person }: { person: Person }) {
  const { adoptToken, reload } = useStore()
  const navigate = useNavigate()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!person.hasPin) {
    return (
      <div className="space-y-2">
        <p className="text-sm">לפרופיל הזה עדיין אין קוד אישי. אם הוא שלכם, קבלו קישור כניסה למייל שבפרופיל, או פתחו את קישור העריכה ששמרתם.</p>
        <SignInLinkButton person={person} />
      </div>
    )
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
      <SignInLinkButton person={person} />
    </form>
  )
}
