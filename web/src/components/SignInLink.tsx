import { useRef, useState } from 'react'
import { api, ApiError, type Person } from '../api.ts'

/** A one-time sign-in link made by an organizer, as POST /api/admin/people/:id/signin-link returns it. */
export interface OrganizerLink {
  url: string
  expiresAt: string
  name: string
}

/**
 * Copies the text, or, when the browser has no clipboard here or refuses, calls `select` so it can be copied by hand.
 * Says whether it was copied.
 */
export async function copyOrSelect(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined, select: () => void): Promise<boolean> {
  try {
    if (!clipboard) throw new Error('No clipboard')
    await clipboard.writeText(text)
    return true
  } catch {
    select()
    return false
  }
}

/** The link ready to copy, with whose it is and how long it works. */
export function LinkToPass({ link }: { link: OrganizerLink }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const copy = async () => {
    const done = await copyOrSelect(link.url, navigator.clipboard, () => inputRef.current?.select())
    setCopied(done)
    setError(done ? '' : 'ההעתקה לא הצליחה. סמנו את הקישור והעתיקו אותו.')
  }
  return (
    <div className="space-y-2 rounded-lg border-[3px] border-ink p-3">
      <p className="font-bold" dir="auto">
        {link.name}
      </p>
      <div className="flex gap-2">
        <input ref={inputRef} className="field text-sm" dir="ltr" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label={`קישור כניסה של ${link.name}`} />
        <button type="button" className="btn btn-plain btn-sm shrink-0" onClick={copy}>
          {copied ? 'הועתק' : 'העתקה'}
        </button>
      </div>
      {error && (
        <p role="alert" className="font-bold">
          {error}
        </p>
      )}
      <p className="text-sm">הקישור עובד פעם אחת ותקף 30 דקות. שלחו אותו רק למי שהפרופיל שלו.</p>
    </div>
  )
}

/**
 * Gets a classmate with no email and a forgotten code back into their profile, with nothing lost: the organizer makes
 * a one-time link and passes it on by hand. `once` is the page's one-action-at-a-time guard, so a double click
 * makes one link, not two. With `onLink` the page shows the link itself, e.g. to keep it after moving on; without
 * it, the link shows here. In a wrapping flex row the button stays in line and the link gets a line of its own.
 */
export default function SignInLink({
  person,
  once,
  busy,
  onLink,
}: {
  person: Person
  once: (action: () => Promise<unknown>) => Promise<void>
  busy: boolean
  onLink?: (link: OrganizerLink) => void
}) {
  const [link, setLink] = useState<OrganizerLink | null>(null)
  const [error, setError] = useState('')

  // A failed attempt leaves the link already shown: it still works.
  const create = () =>
    once(async () => {
      setError('')
      try {
        const made = await api<OrganizerLink>(`/api/admin/people/${person.id}/signin-link`, { method: 'POST' })
        if (onLink) onLink(made)
        else setLink(made)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'משהו השתבש')
      }
    })

  return (
    <>
      <button type="button" className="btn btn-plain btn-sm" disabled={busy} onClick={create}>
        צרו קישור כניסה
      </button>
      {error && (
        <p role="alert" className="order-last basis-full rounded-lg border-[3px] border-ink bg-pink p-3 font-bold text-white">
          {error}
        </p>
      )}
      {link && (
        <div className="order-last basis-full">
          <LinkToPass key={link.url} link={link} />
        </div>
      )}
    </>
  )
}
