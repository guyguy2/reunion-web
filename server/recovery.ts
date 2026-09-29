import crypto from 'node:crypto'
import { newEditToken, sha256 } from './auth.ts'
import type { Db, PersonRow } from './db.ts'
import type { Mailer } from './email.ts'

export const LINK_MINUTES = 30
const COOLDOWN_MINUTES = 2
/** The whole email, relay redirects included, gets this long. */
const SEND_DEADLINE_MS = 60_000

/** "guy@gmail.com" -> "g***@gmail.com", so the page can say where the link went without showing the address. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  return `${user.slice(0, 1)}***@${domain}`
}

/**
 * Makes a one-time sign-in link for the profile, without sending it anywhere. Any earlier link for the profile stops
 * working, so only the newest one is ever out there. `expiresAt` is ISO 8601 in UTC.
 */
export function createSignInLink(db: Db, person: PersonRow, baseUrl: string): { url: string; expiresAt: string } {
  const token = crypto.randomBytes(24).toString('base64url')
  db.prepare('DELETE FROM recovery_tokens WHERE person_id = ?').run(person.id)
  const { expiresAt } = db
    .prepare(
      `INSERT INTO recovery_tokens (token_hash, person_id, expires_at) VALUES (?, ?, datetime('now', ?))
       RETURNING strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expiresAt`,
    )
    .get(sha256(token), person.id, `+${LINK_MINUTES} minutes`) as { expiresAt: string }
  return { url: `${baseUrl}/signin/${token}`, expiresAt }
}

/** Emails a one-time sign-in link to the address on the profile. Throws a user-facing message when it can't. */
export async function sendSignInLink(db: Db, person: PersonRow, mail: Mailer | null, baseUrl: string): Promise<string> {
  if (!mail) throw new Error('שליחת מיילים עוד לא הוגדרה באתר. בקשו מהמארגנים לאפס את הפרופיל.')
  if (!person.email) throw new Error('אין אימייל בפרופיל הזה. בקשו מהמארגנים לאפס אותו.')
  const recent = db
    .prepare(`SELECT 1 FROM recovery_tokens WHERE person_id = ? AND created_at > datetime('now', ?)`)
    .get(person.id, `-${COOLDOWN_MINUTES} minutes`)
  if (recent) throw new Error('כבר שלחנו קישור לפני רגע. בדקו את תיבת הדואר (וגם את הספאם).')

  const { url } = createSignInLink(db, person, baseUrl)
  const token = url.slice(url.lastIndexOf('/') + 1)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException('The email took longer than a minute', 'TimeoutError')), SEND_DEADLINE_MS)
  try {
    await mail({
      to: person.email,
      subject: 'קישור כניסה לפרופיל שלך באתר המחזור',
      text: [
        `שלום ${person.name},`,
        '',
        'ביקשת להיכנס לפרופיל שלך. זה הקישור:',
        url,
        '',
        `הקישור עובד פעם אחת בלבד, במשך ${LINK_MINUTES} דקות. אחרי הכניסה אפשר לבחור קוד אישי חדש.`,
        'אם לא ביקשת את זה, אפשר פשוט להתעלם מהמייל.',
      ].join('\n'),
      signal: deadline.signal,
    })
  } catch (err) {
    // Takes the unsent link back, so the cooldown does not block asking again. The log keeps the reason, never the link.
    db.prepare('DELETE FROM recovery_tokens WHERE token_hash = ?').run(sha256(token))
    console.error(`Sign-in link for person ${person.id} was not emailed: ${String((err as Error).message).replaceAll(token, '[link]')}`)
    throw new Error('לא הצלחנו לשלוח את המייל. נסו שוב בעוד רגע.')
  } finally {
    clearTimeout(timer)
  }
  return maskEmail(person.email)
}

/** Trades a valid, unexpired link for a device key. Each link works once. */
export function redeemSignInLink(db: Db, token: string): { deviceToken: string; personId: number } | null {
  const row = db
    .prepare(`SELECT person_id FROM recovery_tokens WHERE token_hash = ? AND expires_at > datetime('now')`)
    .get(sha256(token)) as { person_id: number } | undefined
  db.prepare('DELETE FROM recovery_tokens WHERE token_hash = ?').run(sha256(token))
  if (!row) return null
  const deviceToken = newEditToken()
  db.prepare('INSERT INTO device_tokens (token_hash, person_id) VALUES (?, ?)').run(sha256(deviceToken), row.person_id)
  return { deviceToken, personId: row.person_id }
}
