import { getMeta, setMeta, type Db } from './db.ts'

const KEY = 'credits'
const MAX_PEOPLE = 60
const MAX_NAME = 60
const MAX_NOTE = 120

export interface Credit {
  name: string
  note?: string
}

/** Whoever helped build the site. Kept in the meta table so the organizers can edit it from the site itself. */
export function listCredits(db: Db): Credit[] {
  const stored = getMeta(db, KEY)
  if (!stored) return []
  try {
    const parsed = JSON.parse(stored) as Credit[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Replaces the whole list. Throws Error with a user-facing message on bad input. */
export function saveCredits(db: Db, body: unknown): Credit[] {
  const rows = (body && typeof body === 'object' ? (body as Record<string, unknown>).credits : null) ?? body
  if (!Array.isArray(rows)) throw new Error('רשימה לא תקינה')
  if (rows.length > MAX_PEOPLE) throw new Error(`עד ${MAX_PEOPLE} שמות`)
  const credits = rows.map((row) => {
    const fields = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const note = typeof fields.note === 'string' ? fields.note.trim() : ''
    if (!name) throw new Error('כל שורה צריכה שם')
    if (name.length > MAX_NAME || note.length > MAX_NOTE) throw new Error('הטקסט ארוך מדי')
    return note ? { name, note } : { name }
  })
  setMeta(db, KEY, JSON.stringify(credits))
  return credits
}
