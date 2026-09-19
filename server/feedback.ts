import type { Config } from './config.ts'
import type { Db, FeedbackRow } from './db.ts'

export type SendEmail = (message: { subject: string; text: string; replyTo?: string }) => Promise<void>

const MAX_MESSAGE = 3000
const EMAIL = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/

/** Emails through Resend's HTTP API. Returns null when no API key or recipient is set; feedback is then only saved. */
export function resendSender(config: Config, fetchImpl: typeof fetch = fetch): SendEmail | null {
  const { resendApiKey, feedbackTo, feedbackFrom } = config
  if (!resendApiKey || !feedbackTo) return null
  return async ({ subject, text, replyTo }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: feedbackFrom, to: [feedbackTo], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    })
    if (!res.ok) throw new Error(`Resend answered ${res.status}`)
  }
}

export function serializeFeedback(row: FeedbackRow) {
  return { id: row.id, message: row.message, sender: row.sender, emailed: Boolean(row.emailed), createdAt: row.created_at }
}

export function listFeedback(db: Db) {
  return (db.prepare('SELECT * FROM feedback ORDER BY id DESC').all() as unknown as FeedbackRow[]).map(serializeFeedback)
}

/** Saves the message first, so it is never lost, then tries to email it. A failed email is logged, not shown to the sender. */
export async function addFeedback(db: Db, body: unknown, send: SendEmail | null) {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  const sender = typeof input.sender === 'string' ? input.sender.trim().slice(0, 200) || null : null
  if (!message) throw new Error('כתבו משהו לפני השליחה')
  if (message.length > MAX_MESSAGE) throw new Error('ההודעה ארוכה מדי')

  const id = Number(db.prepare('INSERT INTO feedback (message, sender) VALUES (?, ?)').run(message, sender).lastInsertRowid)
  if (send) {
    try {
      await send({
        subject: `משוב מאתר המחזור${sender ? ` - ${sender}` : ''}`,
        text: `${message}\n\n-- \n${sender ?? 'ללא שם'}`,
        replyTo: sender?.match(EMAIL)?.[0],
      })
      db.prepare('UPDATE feedback SET emailed = 1 WHERE id = ?').run(id)
    } catch (err) {
      console.error(`Feedback ${id} was saved but not emailed: ${(err as Error).message}`)
    }
  }
  return serializeFeedback(db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as unknown as FeedbackRow)
}
