import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { api, type Note, type Person } from '../api.ts'
import { useStore } from '../store.tsx'
import { LAYER, useEscape } from '../useEscape.ts'

const MAX_NOTE = 1000

function noteDate(createdAt: string): string {
  return new Date(`${createdAt.replace(' ', 'T')}Z`).toLocaleDateString('he-IL')
}

/** A sheet of ruled notebook paper, tilted a little like it was just passed across the room. */
export function NotePaper({ children, tilt = -1, className = '' }: { children: ReactNode; tilt?: number; className?: string }) {
  return (
    <div className={`notebook-paper ${className}`} style={{ transform: `rotate(${tilt}deg)` }}>
      {children}
    </div>
  )
}

/** Writing a note to one classmate. Opens over everything; Escape or the X throws the draft away. */
export function NoteComposer({ to, onClose }: { to: Person; onClose: () => void }) {
  const { me } = useStore()
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(!me)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  useEscape(onClose, LAYER.dialog)

  async function send(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/notes', { json: { to: to.id, message, anonymous } })
      setSent(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/60 p-4" onClick={onClose}>
      <form onSubmit={send} className="w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()} aria-label={`פתק ל${to.name}`}>
        <NotePaper>
          <button type="button" className="btn btn-plain btn-sm pixel absolute top-2 left-2 text-lg leading-none" onClick={onClose} aria-label="סגירה">
            X
          </button>
          {sent ? (
            <p className="notebook-lines py-6 text-center">הפתק קופל ונשלח!</p>
          ) : (
            <>
              <p className="notebook-lines font-bold" dir="auto">
                ל{to.name},
              </p>
              <textarea
                className="notebook-lines block w-full resize-none border-0 bg-transparent p-0 outline-none"
                rows={7}
                dir="auto"
                maxLength={MAX_NOTE}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                aria-label="מה כתוב בפתק"
                placeholder="כתבו כאן..."
                autoFocus
              />
              <p className="notebook-lines text-end" dir="auto">
                {anonymous ? 'מישהו מהמחזור' : me?.name}
              </p>
            </>
          )}
        </NotePaper>

        {sent ? (
          <button type="button" className="btn w-full" onClick={onClose}>
            סגירה
          </button>
        ) : (
          <div className="chunk space-y-3 p-4">
            <label className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" className="h-5 w-5 accent-pink" checked={anonymous} disabled={!me} onChange={(e) => setAnonymous(e.target.checked)} />
              לשלוח בלי שם (אנונימי)
            </label>
            {!me && (
              <p className="text-sm">
                כדי לחתום בשמכם צריך קודם{' '}
                <Link to="/me" className="font-bold underline" onClick={onClose}>
                  פרופיל
                </Link>
                .
              </p>
            )}
            {anonymous && <p className="text-sm opacity-70">פתק אנונימי לא שומר מי שלח אותו, גם לא אצל המנהלים, ולכן אי אפשר לענות עליו.</p>}
            {!to.claimed && <p className="text-sm opacity-70">{to.name} עוד לא הצטרפו לאתר. הפתק יחכה להם עד שיצטרפו.</p>}
            {error && <p className="font-bold text-pink">{error}</p>}
            <div className="flex gap-2">
              <button className="btn btn-pink flex-1" disabled={busy || !message.trim()}>
                {busy ? 'מקפלים...' : 'לקפל ולשלוח'}
              </button>
              <button type="button" className="btn btn-plain" onClick={onClose}>
                ביטול
              </button>
            </div>
          </div>
        )}
      </form>
    </div>,
    document.body,
  )
}

/** A note in your inbox: folded until you open it, then the full page with a way to reply (signed notes only) or throw it away. */
export function NoteCard({
  note,
  index,
  onOpen,
  onThrowAway,
  onReply,
}: {
  note: Note
  index: number
  onOpen: () => void
  onThrowAway: () => void
  onReply?: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const tilt = index % 2 ? 1.2 : -1.2
  const from = note.from?.name ?? 'מישהו מהמחזור'

  if (!note.read) {
    return (
      <button onClick={onOpen} className="block w-full cursor-pointer text-start transition-transform hover:-translate-y-0.5" aria-label={`פתיחת פתק מ${from}`}>
        <NotePaper tilt={tilt} className="py-4">
          <p className="notebook-lines" dir="auto">
            פתק מ{from}
          </p>
          <p className="notebook-lines text-base opacity-70">מקופל. לחצו כדי לפתוח</p>
        </NotePaper>
      </button>
    )
  }

  return (
    <div>
      <NotePaper tilt={tilt}>
        <p className="notebook-lines whitespace-pre-wrap" dir="auto">
          {note.message}
        </p>
        <p className="notebook-lines text-end" dir="auto">
          {from}
        </p>
      </NotePaper>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="flex-1 opacity-70">{noteDate(note.createdAt)}</span>
        {onReply && !confirm && (
          <button className="btn btn-sm" onClick={onReply}>
            לענות
          </button>
        )}
        {confirm ? (
          <>
            <button className="btn btn-pink btn-sm" onClick={onThrowAway}>
              לזרוק לפח
            </button>
            <button className="btn btn-plain btn-sm" onClick={() => setConfirm(false)}>
              להשאיר
            </button>
          </>
        ) : (
          <button className="btn btn-plain btn-sm" onClick={() => setConfirm(true)}>
            לזרוק
          </button>
        )}
      </div>
    </div>
  )
}

/** Your notes, newest first. Opening one marks it read, which also clears the badge on the tab. */
export function NotesInbox() {
  const { setUnreadNotes, personById } = useStore()
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [replyTo, setReplyTo] = useState<Person | null>(null)

  const load = async () => {
    const next = await api<Note[]>('/api/me/notes')
    setNotes(next)
    setUnreadNotes(next.filter((n) => !n.read).length)
  }

  useEffect(() => {
    load().catch(() => setNotes([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function act(action: Promise<unknown>) {
    await action
    await load()
  }

  if (!notes?.length) return null
  return (
    <div className="chunk space-y-5 p-5">
      <h2 className="font-display text-xl">פתקים שקיבלתם</h2>
      {notes.map((note, i) => {
        // Anonymous notes have no sender to answer, and a sender whose profile is gone can't be reached either.
        const sender = personById(note.from?.id)
        return (
          <NoteCard
            key={note.id}
            note={note}
            index={i}
            onOpen={() => act(api(`/api/me/notes/${note.id}/read`, { method: 'POST' }))}
            onThrowAway={() => act(api(`/api/me/notes/${note.id}`, { method: 'DELETE' }))}
            onReply={sender && !sender.inMemoriam ? () => setReplyTo(sender) : undefined}
          />
        )
      })}
      {replyTo && <NoteComposer to={replyTo} onClose={() => setReplyTo(null)} />}
    </div>
  )
}
