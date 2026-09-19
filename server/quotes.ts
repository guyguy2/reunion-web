import type { Db, QuoteCommentRow, QuoteRow } from './db.ts'

const MAX_TEXT = 500
const MAX_SAID_BY = 80
const MAX_CONTEXT = 300
const MAX_COMMENT = 1000
const MAX_NAME = 60

function fieldsOf(body: unknown) {
  const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  return (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
}

export function serializeQuoteComment(row: QuoteCommentRow) {
  return { id: row.id, message: row.message, addedBy: row.added_by, createdAt: row.created_at }
}

export function serializeQuote(row: QuoteRow, comments: QuoteCommentRow[] = []) {
  return {
    id: row.id,
    text: row.text,
    saidBy: row.said_by,
    context: row.context,
    addedBy: row.added_by,
    createdAt: row.created_at,
    comments: comments.map(serializeQuoteComment),
  }
}

/** Newest quote first; each quote's comments in the order they were written. */
export function listQuotes(db: Db) {
  const quotes = db.prepare('SELECT * FROM quotes ORDER BY id DESC').all() as unknown as QuoteRow[]
  const comments = db.prepare('SELECT * FROM quote_comments ORDER BY id').all() as unknown as QuoteCommentRow[]
  const byQuote = new Map<number, QuoteCommentRow[]>()
  for (const c of comments) byQuote.set(c.quote_id, [...(byQuote.get(c.quote_id) ?? []), c])
  return quotes.map((q) => serializeQuote(q, byQuote.get(q.id)))
}

/** Something a teacher or classmate used to say. Throws Error with a user-facing message on bad input. */
export function addQuote(db: Db, body: unknown) {
  const text = fieldsOf(body)
  const quote = text('text')
  const saidBy = text('saidBy') || null
  const context = text('context') || null
  const addedBy = text('addedBy') || null
  if (!quote) throw new Error('מה אמרו? כתבו את המשפט')
  if (quote.length > MAX_TEXT || (saidBy && saidBy.length > MAX_SAID_BY) || (context && context.length > MAX_CONTEXT) || (addedBy && addedBy.length > MAX_NAME)) {
    throw new Error('הטקסט ארוך מדי')
  }
  const result = db.prepare('INSERT INTO quotes (text, said_by, context, added_by) VALUES (?, ?, ?, ?)').run(quote, saidBy, context, addedBy)
  return serializeQuote(db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as QuoteRow)
}

export function addQuoteComment(db: Db, quoteId: number, body: unknown) {
  const text = fieldsOf(body)
  const message = text('message')
  const addedBy = text('addedBy') || null
  if (!db.prepare('SELECT 1 FROM quotes WHERE id = ?').get(quoteId)) throw new Error('הציטוט הזה כבר לא קיים')
  if (!message) throw new Error('התגובה ריקה')
  if (message.length > MAX_COMMENT || (addedBy && addedBy.length > MAX_NAME)) throw new Error('הטקסט ארוך מדי')
  const result = db.prepare('INSERT INTO quote_comments (quote_id, message, added_by) VALUES (?, ?, ?)').run(quoteId, message, addedBy)
  return serializeQuoteComment(db.prepare('SELECT * FROM quote_comments WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as QuoteCommentRow)
}
