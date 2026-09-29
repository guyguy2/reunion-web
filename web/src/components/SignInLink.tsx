import { useState } from 'react'
import { api, ApiError, type Person } from '../api.ts'

/** A one-time sign-in link made by an organizer, as POST /api/admin/people/:id/signin-link returns it. */
export interface OrganizerLink {
  url: string
  expiresAt: string
  name: string
}

/** The link ready to copy, with whose it is and how long it works. */
export function LinkToPass({ link, copied, onCopy }: { link: OrganizerLink; copied: boolean; onCopy: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border-[3px] border-ink p-3">
      <p className="font-bold" dir="auto">
        {link.name}
      </p>
      <div className="flex gap-2">
        <input className="field text-sm" dir="ltr" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label={`קישור כניסה של ${link.name}`} />
        <button type="button" className="btn btn-plain btn-sm shrink-0" onClick={onCopy}>
          {copied ? 'הועתק' : 'העתקה'}
        </button>
      </div>
      <p className="text-sm">הקישור עובד פעם אחת ותקף 30 דקות. שלחו אותו רק למי שהפרופיל שלו.</p>
    </div>
  )
}

/**
 * Gets a classmate with no email and a forgotten code back into their profile, with nothing lost: the organizer makes
 * a one-time link and passes it on by hand. `once` is the page's one-action-at-a-time guard, so a double click
 * makes one link, not two.
 */
export default function SignInLink({ person, once, busy }: { person: Person; once: (action: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const [link, setLink] = useState<OrganizerLink | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const create = () =>
    once(async () => {
      setError('')
      setCopied(false)
      try {
        setLink(await api<OrganizerLink>(`/api/admin/people/${person.id}/signin-link`, { method: 'POST' }))
      } catch (err) {
        setLink(null)
        setError(err instanceof ApiError ? err.message : 'משהו השתבש')
      }
    })
  const copy = () => {
    if (!link) return
    navigator.clipboard.writeText(link.url).then(
      () => setCopied(true),
      () => setError('ההעתקה לא הצליחה. סמנו את הקישור והעתיקו אותו.'),
    )
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-plain btn-sm" disabled={busy} onClick={create}>
        צרו קישור כניסה
      </button>
      {error && (
        <p role="alert" className="rounded-lg border-[3px] border-ink bg-pink p-3 font-bold text-white">
          {error}
        </p>
      )}
      {link && <LinkToPass link={link} copied={copied} onCopy={copy} />}
    </div>
  )
}
