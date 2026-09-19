import type { Db, PersonRow } from './db.ts'

export const EDITABLE_FIELDS = [
  'name',
  'former_name',
  'nickname',
  'email',
  'instagram',
  'linkedin',
  'facebook',
  'x',
  'website',
  'phone',
  'city',
  'bio',
  'quote',
  'attending',
  'gender',
] as const
const FLAG_FIELDS = ['show_email', 'show_instagram', 'show_linkedin', 'show_facebook', 'show_website', 'show_phone', 'show_x'] as const
const ADMIN_FLAG_FIELDS = ['in_memoriam'] as const
const MAX_LENGTH: Record<string, number> = { bio: 1500, quote: 300 }

export type View = 'public' | 'full'

/** Shape sent to the browser. Public view drops hidden contact fields; the token hash never leaves the server. */
export function serializePerson(row: PersonRow, view: View) {
  const full = view === 'full'
  return {
    id: row.id,
    name: row.name,
    formerName: row.former_name,
    nickname: row.nickname,
    email: full || row.show_email ? row.email : null,
    instagram: full || row.show_instagram ? row.instagram : null,
    linkedin: full || row.show_linkedin ? row.linkedin : null,
    facebook: full || row.show_facebook ? row.facebook : null,
    website: full || row.show_website ? row.website : null,
    phone: full || row.show_phone ? row.phone : null,
    x: full || row.show_x ? row.x : null,
    city: row.city,
    bio: row.bio,
    quote: row.quote,
    thenPhoto: row.then_photo ? `/media/${row.then_photo}` : null,
    nowPhoto: row.now_photo ? `/media/${row.now_photo}` : null,
    attending: row.attending,
    gender: row.gender,
    inMemoriam: Boolean(row.in_memoriam),
    claimed: Boolean(row.claimed_at),
    hasPin: Boolean(row.pin_hash),
    ...(full
      ? {
          showEmail: Boolean(row.show_email),
          showInstagram: Boolean(row.show_instagram),
          showLinkedin: Boolean(row.show_linkedin),
          showFacebook: Boolean(row.show_facebook),
          showWebsite: Boolean(row.show_website),
          showPhone: Boolean(row.show_phone),
          showX: Boolean(row.show_x),
        }
      : {}),
  }
}

const CAMEL: Record<string, string> = {
  formerName: 'former_name',
  showEmail: 'show_email',
  showInstagram: 'show_instagram',
  showLinkedin: 'show_linkedin',
  showFacebook: 'show_facebook',
  showWebsite: 'show_website',
  showPhone: 'show_phone',
  showX: 'show_x',
  inMemoriam: 'in_memoriam',
}

/** A bare username becomes a profile link; anything else is treated as a link. */
function cleanFacebook(value: string): string {
  return /^[A-Za-z0-9.]+$/.test(value) && !/facebook\./i.test(value) ? `https://www.facebook.com/${value}` : withScheme(value)
}

function withScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

/** "@handle", "x.com/handle" or "twitter.com/handle" all become the bare handle. */
function cleanX(value: string): string {
  const handle = value.replace(/^(https?:\/\/)?((www|mobile)\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('שם המשתמש ב-X לא תקין')
  return handle
}

function cleanInstagram(value: string): string {
  return value.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '')
}

/** Validates a JSON body into column -> value pairs. Throws Error with a user-facing message on bad input. */
export function parsePersonInput(body: unknown, opts: { admin: boolean }): Record<string, string | number | null> {
  if (!body || typeof body !== 'object') throw new Error('Invalid body')
  const out: Record<string, string | number | null> = {}
  for (const [rawKey, raw] of Object.entries(body as Record<string, unknown>)) {
    const key = CAMEL[rawKey] ?? rawKey
    if ((FLAG_FIELDS as readonly string[]).includes(key) || (opts.admin && (ADMIN_FLAG_FIELDS as readonly string[]).includes(key))) {
      out[key] = raw ? 1 : 0
      continue
    }
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) continue
    if (raw !== null && typeof raw !== 'string') throw new Error(`${rawKey} must be text`)
    let value = raw?.trim() || null
    if (value && value.length > (MAX_LENGTH[key] ?? 200)) throw new Error(`הטקסט ארוך מדי (${rawKey})`)
    if (key === 'name' && !value) throw new Error('חובה למלא שם')
    if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('כתובת האימייל לא תקינה')
    if (key === 'phone' && value && !/^\+?[\d\s().-]{7,25}$/.test(value)) throw new Error('מספר הטלפון לא תקין')
    if (key === 'attending' && value && !['yes', 'no', 'maybe'].includes(value)) throw new Error('Invalid attending value')
    if (key === 'gender' && value && !['m', 'f'].includes(value)) throw new Error('Invalid gender value')
    if (key === 'instagram' && value) value = cleanInstagram(value)
    if (key === 'linkedin' && value && !/^https?:\/\//i.test(value)) value = `https://${value}`
    if (key === 'facebook' && value) value = cleanFacebook(value)
    if (key === 'x' && value) value = cleanX(value)
    if (key === 'website' && value) value = withScheme(value)
    out[key] = value
  }
  return out
}

export function getPerson(db: Db, id: number): PersonRow | undefined {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined
}

export function listPeople(db: Db): PersonRow[] {
  return db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all() as unknown as PersonRow[]
}

export function insertPerson(db: Db, fields: Record<string, string | number | null>): number {
  const keys = Object.keys(fields)
  const result = db
    .prepare(`INSERT INTO people (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => fields[k]))
  return Number(result.lastInsertRowid)
}

export function updatePerson(db: Db, id: number, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  db.prepare(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id,
  )
}

/** Minimal CSV parser: handles quoted fields and embedded commas/newlines. First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') (row.push(field), (field = ''))
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      ;(row = []), (field = '')
    } else field += ch
  }
  if (field || row.length) (row.push(field), rows.push(row))
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim()))
  if (!header) return []
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]?.trim() ?? ''])))
}
