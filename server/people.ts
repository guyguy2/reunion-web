import type { Db, PersonPhotoRow, PersonRow, PhotoKind } from './db.ts'
import { removeUpload, saveUpload } from './images.ts'

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

/** How many "then" photos and how many "now" photos one person may have. */
export const MAX_PHOTOS_PER_KIND = 3

/** Shape sent to the browser. Public view drops hidden contact fields; the token hash never leaves the server. */
export function serializePerson(row: PersonRow, view: View) {
  const full = view === 'full'
  const photos = (kind: PhotoKind) => (row.photos ?? []).filter((p) => p.kind === kind).map((p) => ({ id: p.id, url: `/media/${p.path}` }))
  const thenPhotos = photos('then')
  const nowPhotos = photos('now')
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
    thenPhoto: thenPhotos[0]?.url ?? null,
    nowPhoto: nowPhotos[0]?.url ?? null,
    thenPhotos,
    nowPhotos,
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
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined
  if (row) row.photos = listPhotos(db, id)
  return row
}

export function listPeople(db: Db): PersonRow[] {
  const rows = db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE').all() as unknown as PersonRow[]
  const photos = db.prepare('SELECT id, person_id, kind, path FROM person_photos ORDER BY id').all() as unknown as PersonPhotoRow[]
  const byPerson = new Map<number, PersonPhotoRow[]>()
  for (const photo of photos) byPerson.set(photo.person_id, [...(byPerson.get(photo.person_id) ?? []), photo])
  for (const row of rows) row.photos = byPerson.get(row.id) ?? []
  return rows
}

export function listPhotos(db: Db, personId: number, kind?: PhotoKind): PersonPhotoRow[] {
  const where = kind ? 'person_id = ? AND kind = ?' : 'person_id = ?'
  const args = kind ? [personId, kind] : [personId]
  return db.prepare(`SELECT id, person_id, kind, path FROM person_photos WHERE ${where} ORDER BY id`).all(...args) as unknown as PersonPhotoRow[]
}

/**
 * person_photos is the source of truth; people.then_photo / people.now_photo mirror the oldest photo of
 * each kind for the portrait wall (images.ts, scenes.ts). Only addPhoto and deletePhoto write either one.
 */
function syncPrimary(db: Db, personId: number, kind: PhotoKind) {
  const column = kind === 'then' ? 'then_photo' : 'now_photo'
  db.prepare(`UPDATE people SET ${column} = (SELECT path FROM person_photos WHERE person_id = ? AND kind = ? ORDER BY id LIMIT 1) WHERE id = ?`)
    .run(personId, kind, personId)
}

/** Stores an uploaded image and attaches it to the person. Throws once they are at the cap. */
export async function addPhoto(db: Db, dataDir: string, personId: number, kind: PhotoKind, input: Buffer): Promise<PersonPhotoRow> {
  if (listPhotos(db, personId, kind).length >= MAX_PHOTOS_PER_KIND) {
    throw new Error(`אפשר להעלות עד ${MAX_PHOTOS_PER_KIND} תמונות. מחקו אחת כדי להוסיף חדשה.`)
  }
  const rel = await saveUpload(dataDir, input)
  const result = db.prepare('INSERT INTO person_photos (person_id, kind, path) VALUES (?, ?, ?)').run(personId, kind, rel)
  syncPrimary(db, personId, kind)
  return { id: Number(result.lastInsertRowid), person_id: personId, kind, path: rel }
}

/** Detaches one photo and deletes its file. Returns false if it is not this person's. */
export function deletePhoto(db: Db, dataDir: string, personId: number, photoId: number): boolean {
  const photo = db.prepare('SELECT id, person_id, kind, path FROM person_photos WHERE id = ? AND person_id = ?').get(photoId, personId) as
    | PersonPhotoRow
    | undefined
  if (!photo) return false
  db.prepare('DELETE FROM person_photos WHERE id = ?').run(photo.id)
  removeUpload(dataDir, photo.path)
  syncPrimary(db, personId, photo.kind)
  return true
}

/** Drops every photo of a kind (or all of them), files included. */
export function deletePhotos(db: Db, dataDir: string, personId: number, kind?: PhotoKind) {
  for (const photo of listPhotos(db, personId, kind)) deletePhoto(db, dataDir, personId, photo.id)
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
