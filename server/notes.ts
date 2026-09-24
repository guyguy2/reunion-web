import type { Db, NoteRow, PersonRow } from './db.ts'
import type { Mailer } from './email.ts'
import { getPerson } from './people.ts'

const MAX_MESSAGE = 1000
/** At most one "you got a note" email per person in this many hours, so a burst of notes (anonymous ones included) can't flood an inbox. */
const ALERT_HOURS = 12

/** Anonymous notes store no sender at all, so nobody (admins included) can find out who wrote them. */
export function serializeNote(row: NoteRow) {
  return {
    id: row.id,
    message: row.message,
    from: row.sender_name ? { id: row.sender_id, name: row.sender_name } : null,
    read: Boolean(row.read_at),
    createdAt: row.created_at,
  }
}

/** A note passed to a classmate. Signed notes need the sender's own profile; anyone may send anonymously. */
export function sendNote(db: Db, body: unknown, sender: PersonRow | undefined) {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  const anonymous = input.anonymous === true
  const recipient = getPerson(db, Number(input.to))
  if (!recipient) throw new Error('לא מצאנו למי לשלוח')
  if (recipient.in_memoriam) throw new Error('אי אפשר לשלוח פתק לפרופיל הזה')
  if (!message) throw new Error('הפתק ריק')
  if (message.length > MAX_MESSAGE) throw new Error('הפתק ארוך מדי')
  if (!anonymous && !sender) throw new Error('כדי לחתום בשמכם צריך קודם פרופיל. אפשר לשלוח בלי שם.')
  if (sender?.id === recipient.id) throw new Error('אי אפשר לשלוח פתק לעצמכם')

  const from = anonymous ? null : sender!
  db.prepare('INSERT INTO notes (recipient_id, sender_id, sender_name, message) VALUES (?, ?, ?, ?)').run(
    recipient.id,
    from?.id ?? null,
    from?.name ?? null,
    message,
  )
  return recipient
}

/** Never says who wrote the note or what it says: that stays on the site, behind the recipient's sign-in. */
export function noteAlertEmail(name: string, baseUrl: string) {
  return {
    subject: 'מישהו מהמחזור העביר לך פתק',
    text: [
      `שלום ${name},`,
      '',
      'מישהו מהמחזור העביר לך פתק באתר.',
      'את הפתק אפשר לקרוא רק באתר, בפרופיל שלך:',
      `${baseUrl}/me`,
      '',
      'אם זו הפעם הראשונה שלך באתר, בדף הזה מוסבר איך למצוא את עצמך בספר המחזור ולקחת את הפרופיל.',
    ].join('\n'),
  }
}

/** Tells the recipient a note is waiting, when email is set up and there is an address on the profile.
 * The note is already saved, so a failed email is only logged. */
export async function emailNoteAlert(db: Db, recipient: PersonRow, mail: Mailer | null, baseUrl: string) {
  if (!mail || !recipient.email) return
  // Takes the slot in one statement, so two notes arriving together send one email.
  const due = db
    .prepare(
      `INSERT INTO note_alerts (person_id, sent_at) VALUES (?, datetime('now'))
       ON CONFLICT(person_id) DO UPDATE SET sent_at = excluded.sent_at WHERE note_alerts.sent_at <= datetime('now', ?)`,
    )
    .run(recipient.id, `-${ALERT_HOURS} hours`).changes > 0
  if (!due) return
  try {
    await mail({ to: recipient.email, ...noteAlertEmail(recipient.name, baseUrl) })
  } catch (err) {
    // Gives the slot back, so the next note tries again.
    db.prepare('DELETE FROM note_alerts WHERE person_id = ?').run(recipient.id)
    console.error(`Note alert for person ${recipient.id} was not emailed: ${(err as Error).message}`)
  }
}

export function listNotes(db: Db, recipientId: number) {
  return (db.prepare('SELECT * FROM notes WHERE recipient_id = ? ORDER BY id DESC').all(recipientId) as unknown as NoteRow[]).map(serializeNote)
}

export function unreadNotes(db: Db, recipientId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE recipient_id = ? AND read_at IS NULL').get(recipientId) as { n: number }).n
}

/** Both only touch notes addressed to `recipientId`, so nobody can open or throw away someone else's note. */
export function markNoteRead(db: Db, recipientId: number, id: number): boolean {
  return db.prepare("UPDATE notes SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND recipient_id = ?").run(id, recipientId).changes > 0
}

export function deleteNote(db: Db, recipientId: number, id: number): boolean {
  return db.prepare('DELETE FROM notes WHERE id = ? AND recipient_id = ?').run(id, recipientId).changes > 0
}
