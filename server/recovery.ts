import crypto from 'node:crypto'
import { newEditToken, sha256 } from './auth.ts'
import type { Db, PersonRow } from './db.ts'
import type { Mailer } from './email.ts'

export const LINK_MINUTES = 30
const COOLDOWN_MINUTES = 2

/** "guy@gmail.com" -> "g***@gmail.com", so the page can say where the link went without showing the address. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@')
  return `${user.slice(0, 1)}***@${domain}`
}

/** Emails a one-time sign-in link to the address on the profile. Throws a user-facing message when it can't. */
export async function sendSignInLink(db: Db, person: PersonRow, mail: Mailer | null, baseUrl: string): Promise<string> {
  if (!mail) throw new Error('שליחת מיילים עוד לא הוגדרה באתר. בקשו מהמארגנים לאפס את הפרופיל.')
  if (!person.email) throw new Error('אין אימייל בפרופיל הזה. בקשו מהמארגנים לאפס אותו.')
  const recent = db
    .prepare(`SELECT 1 FROM recovery_tokens WHERE person_id = ? AND created_at > datetime('now', ?)`)
    .get(person.id, `-${COOLDOWN_MINUTES} minutes`)
  if (recent) throw new Error('כבר שלחנו קישור לפני רגע. בדקו את תיבת הדואר (וגם את הספאם).')

  const token = crypto.randomBytes(24).toString('base64url')
  db.prepare(`INSERT INTO recovery_tokens (token_hash, person_id, expires_at) VALUES (?, ?, datetime('now', ?))`).run(
    sha256(token),
    person.id,
    `+${LINK_MINUTES} minutes`,
  )
  await mail({
    to: person.email,
    subject: 'קישור כניסה לפרופיל שלך באתר המחזור',
    text: [
      `שלום ${person.name},`,
      '',
      'ביקשת להיכנס לפרופיל שלך. זה הקישור:',
      `${baseUrl}/signin/${token}`,
      '',
      `הקישור עובד פעם אחת בלבד, במשך ${LINK_MINUTES} דקות. אחרי הכניסה אפשר לבחור קוד אישי חדש.`,
      'אם לא ביקשת את זה, אפשר פשוט להתעלם מהמייל.',
    ].join('\n'),
  })
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
