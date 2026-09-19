import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api.ts'
import { useStore } from '../store.tsx'

/** A "feedback" button in the header; the form drops down below it. The message goes to the organizers by email. */
export default function Feedback() {
  const { me } = useStore()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [sender, setSender] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && !sender && me) setSender(me.email ? `${me.name} <${me.email}>` : me.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  async function send(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      await api('/api/feedback', { json: { message, sender } })
      setMessage('')
      setStatus({ kind: 'ok', text: 'תודה! ההודעה נשלחה.' })
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        className="cursor-pointer text-sm font-bold underline decoration-2 underline-offset-2 opacity-70 hover:opacity-100"
        onClick={() => (setOpen(!open), setStatus(null))}
        aria-expanded={open}
      >
        משוב
      </button>
      {open && (
        <form onSubmit={send} className="chunk fixed end-3 top-14 z-40 w-[min(20rem,calc(100vw-1.5rem))] space-y-3 p-4 shadow-chunk-lg" aria-label="שליחת משוב">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-lg">משוב</h2>
            <button type="button" className="btn btn-plain btn-sm pixel text-lg leading-none" onClick={() => setOpen(false)} aria-label="סגירה">
              x
            </button>
          </div>
          <p className="text-sm">משהו לא עובד? רעיון? כתבו לנו.</p>
          <textarea
            className="field min-h-28"
            dir="auto"
            maxLength={3000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-label="ההודעה"
            autoFocus
            required
          />
          <div>
            <label className="label" htmlFor="feedback-sender">
              מי כותב? (לא חובה)
            </label>
            <input id="feedback-sender" className="field" dir="auto" maxLength={200} value={sender} onChange={(e) => setSender(e.target.value)} placeholder="שם או אימייל לתשובה" />
          </div>
          {status && (
            <p role="status" className={`rounded-lg border-[3px] border-ink p-2 text-sm font-bold text-white ${status.kind === 'ok' ? 'bg-teal' : 'bg-pink'}`}>
              {status.text}
            </p>
          )}
          <button className="btn btn-pink w-full" disabled={busy || !message.trim()}>
            {busy ? 'שולחים...' : 'שליחה'}
          </button>
        </form>
      )}
    </>
  )
}
