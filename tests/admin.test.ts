import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { addPhoto, getPerson, insertPerson } from '../server/people.ts'
import { getScene, insertTag } from '../server/scenes.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-admin-test-'))
const config: Config = {
  dataDir,
  classPasscode: 'class-pass',
  adminPasscode: 'admin-pass',
  sessionSecret: 'test-secret',
  port: 0,
  webDir: path.join(dataDir, 'web'),
  secureCookies: false,
}
const db = openDb(dataDir)
const app = createApp(config, db)

async function login(passcode: string): Promise<string> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.0.9' },
    body: JSON.stringify({ passcode }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]
}

let member: string
let admin: string

beforeAll(async () => {
  member = await login('class-pass')
  admin = await login('admin-pass')
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('version', () => {
  it('shows organizers which build is live', async () => {
    const res = await createApp({ ...config, version: '2026-09-21 19:50 6756e05' }, db).request('/api/admin/version', { headers: { Cookie: admin } })
    expect(await res.json()).toEqual({ version: '2026-09-21 19:50 6756e05' })
  })

  it('is empty when running locally, and for organizers only', async () => {
    expect(await (await app.request('/api/admin/version', { headers: { Cookie: admin } })).json()).toEqual({ version: null })
    expect((await app.request('/api/admin/version', { headers: { Cookie: member } })).status).toBe(403)
  })
})

describe('admin overview', () => {
  it('is for organizers only', async () => {
    expect((await app.request('/api/admin/stats', { headers: { Cookie: member } })).status).toBe(403)
  })

  it('counts people, faces, notes, feedback and visits without revealing what the notes say', async () => {
    const stats = async () => {
      const res = await app.request('/api/admin/stats', { headers: { Cookie: admin } })
      expect(res.status).toBe(200)
      return res.text()
    }
    // Counted against what was there before, so the numbers do not depend on the tests that ran first.
    const before = JSON.parse(await stats())
    const dana = insertPerson(db, { name: 'Dana', attending: 'yes', claimed_at: '2026-09-18T00:00:00Z', pin_hash: 'pin-salt:pin-hash' })
    insertPerson(db, { name: 'Noa', attending: 'maybe', in_memoriam: 1 })
    db.prepare('INSERT INTO notes (recipient_id, message) VALUES (?, ?)').run(dana, 'A secret only Dana should read')
    db.prepare('INSERT INTO feedback (message) VALUES (?)').run('Great site')
    // A class photo with a named face, an unnamed one and a hidden staff face, and the portrait wall, which is not counted.
    const scene = (slug: string, kind: string) =>
      Number(db.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES (?, ?, ?, 600, 400, ?)`).run(slug, slug, kind, `scenes/${slug}`).lastInsertRowid)
    const group = scene('stats-group', 'group')
    insertTag(db, group, { x: 1, y: 1, w: 10, h: 10 }, dana)
    insertTag(db, group, { x: 20, y: 1, w: 10, h: 10 }, null)
    db.prepare('UPDATE tags SET is_staff = 1 WHERE id = ?').run(insertTag(db, group, { x: 40, y: 1, w: 10, h: 10 }, null))
    insertTag(db, scene('stats-wall', 'mosaic'), { x: 1, y: 1, w: 10, h: 10 }, dana)
    await login('class-pass')

    const text = await stats()
    expect(JSON.parse(text)).toMatchObject({
      people: before.people + 2,
      claimed: before.claimed + 1,
      withPin: before.withPin + 1,
      inMemoriam: before.inMemoriam + 1,
      attending: { yes: before.attending.yes + 1, maybe: before.attending.maybe + 1, no: before.attending.no },
      faces: before.faces + 2,
      facesNamed: before.facesNamed + 1,
      notes: before.notes + 1,
      notesUnread: before.notesUnread + 1,
      feedback: before.feedback + 1,
      visits: before.visits + 1,
    })
    expect(text).not.toContain('secret')
  })
})

describe('backup export', () => {
  it('is for organizers only', async () => {
    expect((await app.request('/api/admin/export', { headers: { Cookie: member } })).status).toBe(403)
  })

  it('downloads every profile, picture and face tag, without sign-in secrets or notes', async () => {
    const owner = insertPerson(db, { name: 'Backup Owner', email: 'owner@example.com', edit_token_hash: 'edit-hash', pin_hash: 'pin-salt:pin-hash' })
    const scene = Number(
      db.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES ('prom', 'Prom', 'group', 600, 400, 'scenes/prom')`).run().lastInsertRowid,
    )
    db.prepare('INSERT INTO tags (scene_id, person_id, x, y, w, h) VALUES (?, ?, 1, 2, 3, 4), (?, NULL, 5, 6, 7, 8)').run(scene, owner, scene)
    db.prepare('INSERT INTO device_tokens (token_hash, person_id) VALUES (?, ?)').run('device-hash', owner)

    const res = await app.request('/api/admin/export', { headers: { Cookie: admin } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="reunion-backup-\d{4}-\d{2}-\d{2}\.json"$/)
    const text = await res.text()
    const backup = JSON.parse(text)
    expect(backup.people.find((p: { id: number }) => p.id === owner)).toMatchObject({ name: 'Backup Owner', email: 'owner@example.com' })
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    expect(backup.people.length).toBe(count('people'))
    expect(backup.scenes.length).toBe(count('scenes'))
    expect(backup.tags.length).toBe(count('tags'))
    expect(backup.scenes.filter((s: { id: number }) => s.id === scene)).toEqual([expect.objectContaining({ id: scene, title: 'Prom', kind: 'group' })])
    expect(backup.tags.filter((t: { scene_id: number }) => t.scene_id === scene)).toEqual([
      expect.objectContaining({ scene_id: scene, person_id: owner, x: 1, y: 2, w: 3, h: 4 }),
      expect.objectContaining({ scene_id: scene, person_id: null }),
    ])
    for (const secret of ['edit-hash', 'pin-hash', 'device-hash', 'edit_token_hash', 'pin_hash', 'secret']) expect(text).not.toContain(secret)
  })
})

describe('no delete-everything', () => {
  it('has no route that wipes the whole site, even for organizers', async () => {
    const res = await app.request('/api/admin/wipe', {
      method: 'POST',
      headers: { Cookie: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE EVERYTHING' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('renaming a person', () => {
  const rename = (cookie: string, id: number, name: unknown) =>
    app.request(`/api/admin/people/${id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  const nameOf = (id: number) => (db.prepare('SELECT name FROM people WHERE id = ?').get(id) as { name: string }).name

  it('is for organizers only', async () => {
    const id = insertPerson(db, { name: 'D. Levi' })
    expect((await rename(member, id, 'Dana Levi')).status).toBe(403)
    expect(nameOf(id)).toBe('D. Levi')
  })

  it('trims the new name and leaves the rest of the profile alone', async () => {
    const id = insertPerson(db, { name: 'D. Levi', city: 'Haifa', claimed_at: '2026-09-18T00:00:00Z' })
    const res = await rename(admin, id, '  Dana Levi  ')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'Dana Levi', city: 'Haifa', claimed: true })
  })

  it('will not blank out a name', async () => {
    const id = insertPerson(db, { name: 'Yossi Cohen' })
    expect((await rename(admin, id, '   ')).status).toBe(400)
    expect((await rename(admin, id, null)).status).toBe(400)
    expect(nameOf(id)).toBe('Yossi Cohen')
  })

  it('says so when there is nobody with that id', async () => {
    expect((await rename(admin, 999999, 'Nobody')).status).toBe(404)
  })
})

describe('credits', () => {
  const put = (cookie: string, body: unknown) =>
    app.request('/api/admin/credits', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const credits = async (cookie: string) => ((await (await app.request('/api/event', { headers: { Cookie: cookie } })).json()) as { credits: unknown }).credits

  it('saves the list and serves it with the event details', async () => {
    await put(admin, { credits: [] })
    expect(await credits(member)).toEqual([])
    const res = await put(admin, { credits: [{ name: 'דנה', note: 'סרקה את ספר המחזור' }, { name: 'יוסי', note: '' }] })
    expect(res.status).toBe(200)
    expect(await credits(member)).toEqual([{ name: 'דנה', note: 'סרקה את ספר המחזור' }, { name: 'יוסי' }])
  })

  it('replaces the whole list, so removing someone sticks', async () => {
    await put(admin, { credits: [{ name: 'רק אני' }] })
    expect(await credits(member)).toEqual([{ name: 'רק אני' }])
  })

  it('refuses a nameless row and anything too long', async () => {
    await put(admin, { credits: [{ name: 'רק אני' }] })
    expect((await put(admin, { credits: [{ name: '  ' }] })).status).toBe(400)
    expect((await put(admin, { credits: [{ name: 'x'.repeat(61) }] })).status).toBe(400)
    expect((await put(admin, { credits: 'nope' })).status).toBe(400)
    expect(await credits(member)).toEqual([{ name: 'רק אני' }])
  })

  it('keeps whatever order the organizers put the list in', async () => {
    await put(admin, { credits: [{ name: 'ראשון' }, { name: 'שני' }, { name: 'שלישי' }] })
    expect(await credits(member)).toEqual([{ name: 'ראשון' }, { name: 'שני' }, { name: 'שלישי' }])
    await put(admin, { credits: [{ name: 'שלישי' }, { name: 'ראשון' }, { name: 'שני' }] })
    expect(await credits(member)).toEqual([{ name: 'שלישי' }, { name: 'ראשון' }, { name: 'שני' }])
  })

  it('is closed to members', async () => {
    expect((await put(member, { credits: [] })).status).toBe(403)
  })
})

describe('clearing the unnamed faces of a picture', () => {
  it('keeps the staff faces and their captions', async () => {
    const scene = Number(
      db.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES ('staff-room', 'Staff room', 'group', 600, 400, 'scenes/staff-room')`).run().lastInsertRowid,
    )
    const person = insertPerson(db, { name: 'Named Face' })
    const tag = (personId: number | null, staff: number, caption: string | null) =>
      Number(db.prepare('INSERT INTO tags (scene_id, person_id, x, y, w, h, is_staff, caption) VALUES (?, ?, 1, 1, 10, 10, ?, ?)').run(scene, personId, staff, caption).lastInsertRowid)
    const named = tag(person, 0, null)
    tag(null, 0, 'ד. פלוני')
    const staff = tag(null, 1, 'המנהלת')

    const res = await app.request(`/api/admin/scenes/${scene}/unidentified-tags`, { method: 'DELETE', headers: { Cookie: admin } })
    expect(await res.json()).toEqual({ removed: 1 })
    expect(db.prepare('SELECT id, caption, is_staff FROM tags WHERE scene_id = ? ORDER BY id').all(scene)).toEqual([
      { id: named, caption: null, is_staff: 0 },
      { id: staff, caption: 'המנהלת', is_staff: 1 },
    ])
  })
})

describe('CSV import', () => {
  const upload = async (csv: string) =>
    (await (await app.request('/api/admin/import-csv', { method: 'POST', headers: { Cookie: admin }, body: csv })).json()) as { added: number; skipped: string[] }
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n

  it('skips people who are already on the list, so uploading the same file twice adds nobody twice', async () => {
    const csv = 'name,city\nMaya Katz,Haifa\nאורי לוי,תל אביב\n'
    expect(await upload(csv)).toEqual({ added: 2, skipped: [] })
    const before = count()

    const again = await upload(csv)
    expect(again).toEqual({ added: 0, skipped: [expect.stringContaining('שורה 2'), expect.stringContaining('שורה 3')] })
    expect(again.skipped[0]).toContain('Maya Katz')
    expect(count()).toBe(before)

    // Case and spacing do not make it someone new.
    expect(await upload('name\n  maya KATZ \n')).toEqual({ added: 0, skipped: [expect.stringContaining('שורה 2')] })
    expect(count()).toBe(before)
  })
})

describe('deleting a person', () => {
  it('removes the profile with its photo files, notes and device keys, and leaves its faces unnamed', async () => {
    const png = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#ec4899' } }).png().toBuffer()
    const id = insertPerson(db, { name: 'Jenny Carter', claimed_at: '2026-09-18T00:00:00Z' })
    const photo = await addPhoto(db, dataDir, id, 'now', png)
    const scene = Number(
      db.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES ('reunion', 'Reunion', 'group', 600, 400, 'scenes/reunion')`).run().lastInsertRowid,
    )
    const face = insertTag(db, scene, { x: 1, y: 1, w: 10, h: 10 }, id)
    db.prepare('INSERT INTO notes (recipient_id, message) VALUES (?, ?)').run(id, 'See you there')
    db.prepare('INSERT INTO device_tokens (token_hash, person_id) VALUES (?, ?)').run('deleted-person-device', id)
    const left = (table: string, column: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number }).n
    expect(fs.existsSync(path.join(dataDir, photo.path))).toBe(true)

    expect((await app.request(`/api/admin/people/${id}`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)
    expect(getPerson(db, id)).toBeDefined()

    const res = await app.request(`/api/admin/people/${id}`, { method: 'DELETE', headers: { Cookie: admin } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(getPerson(db, id)).toBeUndefined()
    expect(fs.existsSync(path.join(dataDir, photo.path))).toBe(false)
    expect([left('person_photos', 'person_id'), left('notes', 'recipient_id'), left('device_tokens', 'person_id')]).toEqual([0, 0, 0])
    expect(db.prepare('SELECT person_id FROM tags WHERE id = ?').get(face)).toEqual({ person_id: null })

    expect((await app.request(`/api/admin/people/${id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(404)
  })
})

describe('deleting a class photo', () => {
  it('removes the picture, its tiles and its face tags, and keeps the people', async () => {
    const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#14b8a6' } }).png().toBuffer()
    const form = new FormData()
    form.set('image', new File([new Uint8Array(png)], 'class.png', { type: 'image/png' }))
    form.set('title', '1996 - graduation')
    const uploaded = await app.request('/api/admin/scenes', { method: 'POST', headers: { Cookie: admin }, body: form })
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json()
    const tiles = path.join(dataDir, getScene(db, id)!.tiles_path)
    expect(fs.existsSync(path.join(tiles, 'scene.dzi'))).toBe(true)
    const person = insertPerson(db, { name: 'Jenny Carter' })
    const face = insertTag(db, id, { x: 10, y: 10, w: 50, h: 60 }, person)

    expect((await app.request(`/api/admin/scenes/${id}`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)
    expect(getScene(db, id)).toBeDefined()

    const res = await app.request(`/api/admin/scenes/${id}`, { method: 'DELETE', headers: { Cookie: admin } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(getScene(db, id)).toBeUndefined()
    expect(fs.existsSync(tiles)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ? OR scene_id = ?').get(face, id)).toEqual({ n: 0 })
    expect(getPerson(db, person)).toBeDefined()

    expect((await app.request(`/api/admin/scenes/${id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(404)
  })
})

describe('loading the demo data', () => {
  it('refuses a site that already has people, with 409, and adds nothing', async () => {
    insertPerson(db, { name: 'Jenny Carter' })
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const files = (folder: string) => (fs.existsSync(path.join(dataDir, folder)) ? fs.readdirSync(path.join(dataDir, folder)).length : 0)
    const snapshot = () => [count('people'), count('scenes'), count('tags'), count('person_photos'), files('uploads'), files('scenes')]
    const before = snapshot()

    const res = await app.request('/api/admin/demo', { method: 'POST', headers: { Cookie: admin } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'אפשר לטעון נתוני הדגמה רק לאתר ריק, בלי אנשים ובלי תמונות מחזור' })
    expect(snapshot()).toEqual(before)
  })
})
