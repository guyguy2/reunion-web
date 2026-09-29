import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { saveCredits } from '../server/credits.ts'
import { openDb } from '../server/db.ts'
import { addPhoto, getPerson, insertPerson, listPhotos, MAX_PHOTOS_PER_KIND, parsePersonInput } from '../server/people.ts'
import { listQuotes, REACTIONS, reactToQuote } from '../server/quotes.ts'
import { insertTag } from '../server/scenes.ts'
import { addTape } from '../server/tapes.ts'
import { addVideo } from '../server/videos.ts'

const dirs: string[] = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-admin-errors-test-'))
  dirs.push(dir)
  return dir
}

const dataDir = tempDir()
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

async function login(passcode: string, ip: string, target = app): Promise<string> {
  const res = await target.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ passcode }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]
}

function json(method: string, body: unknown, headers: Record<string, string>) {
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

/** A 400 (or other status) whose message is Hebrew text written for people, not a stack trace or a JS error. */
async function expectHebrewError(res: Response, status = 400): Promise<string> {
  expect(res.status).toBe(status)
  const { error } = (await res.json()) as { error: string }
  expect(error).toMatch(/[א-ת]/)
  expect(error).not.toMatch(/Cannot|TypeError|reading|undefined|null|Invalid|Unknown/)
  return error
}

const picture = () => sharp({ create: { width: 60, height: 60, channels: 3, background: '#14b8a6' } }).png().toBuffer()
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const tagRow = (id: number) => db.prepare('SELECT * FROM tags WHERE id = ?').get(id)

let admin: string

beforeAll(async () => {
  admin = await login('admin-pass', '10.61.0.1')
})

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('admin JSON bodies that are null or a list', () => {
  let person: number
  let scene: number
  let tag: number
  let uncaptioned: number

  beforeAll(() => {
    person = insertPerson(db, { name: 'Jenny Carter', city: 'Haifa' })
    scene = Number(
      db.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES ('bodies', 'Bodies', 'group', 600, 400, 'scenes/bodies')`).run()
        .lastInsertRowid,
    )
    tag = insertTag(db, scene, { x: 10, y: 10, w: 40, h: 50 }, person)
    db.prepare('UPDATE tags SET caption = ? WHERE id = ?').run('י. ישראלי', tag)
    uncaptioned = insertTag(db, scene, { x: 100, y: 10, w: 40, h: 50 }, null)
  })

  const routes = (): [method: string, url: string][] => [
    ['POST', '/api/admin/people'],
    ['PATCH', `/api/admin/people/${person}`],
    ['POST', `/api/admin/people/${person}/merge`],
    ['POST', `/api/admin/scenes/${scene}/tags`],
    ['POST', `/api/admin/scenes/${scene}/tags/batch`],
    ['PATCH', `/api/admin/tags/${tag}`],
    ['POST', `/api/admin/tags/${uncaptioned}/new-person`],
    ['POST', '/api/admin/roster/import'],
  ]

  for (const body of [null, []]) {
    it(`answers ${JSON.stringify(body)} with a Hebrew 400 on every route that reads JSON, and changes nothing`, async () => {
      const before = { people: count('people'), tags: count('tags'), person: getPerson(db, person), tag: tagRow(tag), uncaptioned: tagRow(uncaptioned) }
      for (const [method, url] of routes()) {
        const res = await app.request(url, json(method, body, { Cookie: admin }))
        await expectHebrewError(res).catch((err) => {
          throw new Error(`${method} ${url}: ${(err as Error).message}`)
        })
      }
      expect({ people: count('people'), tags: count('tags'), person: getPerson(db, person), tag: tagRow(tag), uncaptioned: tagRow(uncaptioned) }).toEqual(before)
    })
  }

  it('still edits a face and a profile when the body names a field', async () => {
    const face = await app.request(`/api/admin/tags/${tag}`, json('PATCH', { classLabel: "ט'-3" }, { Cookie: admin }))
    expect(face.status).toBe(200)
    expect(await face.json()).toMatchObject({ caption: 'י. ישראלי', classLabel: "ט'-3", personId: person })
    const profile = await app.request(`/api/admin/people/${person}`, json('PATCH', { nickname: 'Jen' }, { Cookie: admin }))
    expect(profile.status).toBe(200)
    expect(await profile.json()).toMatchObject({ name: 'Jenny Carter', nickname: 'Jen', city: 'Haifa' })
  })

  it('refuses a face box or a person that does not exist in Hebrew', async () => {
    await expectHebrewError(await app.request(`/api/admin/scenes/${scene}/tags`, json('POST', { x: 1, y: 1, w: 0, h: 5 }, { Cookie: admin })))
    await expectHebrewError(await app.request(`/api/admin/scenes/${scene}/tags`, json('POST', { x: 1, y: 1, w: 5, h: 5, personId: 999999 }, { Cookie: admin })))
    await expectHebrewError(await app.request(`/api/admin/tags/${tag}`, json('PATCH', { personId: 999999 }, { Cookie: admin })))
    await expectHebrewError(await app.request(`/api/admin/scenes/${scene}/tags/batch`, json('POST', { boxes: 'nope' }, { Cookie: admin })))
    expect((tagRow(tag) as { person_id: number }).person_id).toBe(person)
  })
})

describe('loading the demo data', () => {
  const NOT_EMPTY = 'אפשר לטעון נתוני הדגמה רק לאתר ריק, בלי אנשים ובלי תמונות מחזור'

  async function freshSite() {
    const dir = tempDir()
    const siteDb = openDb(dir)
    const site = createApp({ ...config, dataDir: dir }, siteDb)
    return { db: siteDb, site, cookie: await login('admin-pass', '10.61.1.1', site) }
  }

  it('answers 409 with the reason when the site has a class photo but no people', async () => {
    const { db: siteDb, site, cookie } = await freshSite()
    siteDb.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES ('prom', 'Prom', 'group', 600, 400, 'scenes/prom')`).run()
    const res = await site.request('/api/admin/demo', { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NOT_EMPTY })
  })

  it('answers 409 with the same reason when the site has people', async () => {
    const { db: siteDb, site, cookie } = await freshSite()
    insertPerson(siteDb, { name: 'Jenny Carter' })
    const res = await site.request('/api/admin/demo', { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NOT_EMPTY })
  })

  it('still answers 500 for any other failure', async () => {
    const { db: siteDb, site, cookie } = await freshSite()
    siteDb.exec(`CREATE TRIGGER no_people BEFORE INSERT ON people BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await site.request('/api/admin/demo', { method: 'POST', headers: { Cookie: cookie } })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'משהו השתבש' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe('merging and marking staff', () => {
  it('refuses to merge a profile into itself, in Hebrew', async () => {
    const id = insertPerson(db, { name: 'Casey Morgan' })
    await expectHebrewError(await app.request(`/api/admin/people/${id}/merge`, json('POST', { intoId: id }, { Cookie: admin })))
    expect(getPerson(db, id)).toBeDefined()
  })

  it('refuses to merge away or mark as staff a claimed profile, in Hebrew', async () => {
    const claimed = insertPerson(db, { name: 'Riley Brooks', claimed_at: '2026-09-18T00:00:00Z' })
    const other = insertPerson(db, { name: 'ר. ברוקס' })
    await expectHebrewError(await app.request(`/api/admin/people/${claimed}/merge`, json('POST', { intoId: other }, { Cookie: admin })))
    await expectHebrewError(await app.request(`/api/admin/people/${claimed}/staff`, { method: 'POST', headers: { Cookie: admin } }))
    expect(getPerson(db, claimed)).toBeDefined()
    expect(getPerson(db, other)).toBeDefined()
  })

  it('asks for the profile to merge into when none is given', async () => {
    const id = insertPerson(db, { name: 'Avery Lane' })
    await expectHebrewError(await app.request(`/api/admin/people/${id}/merge`, json('POST', {}, { Cookie: admin })))
    expect(getPerson(db, id)).toBeDefined()
  })

  it('keeps the plain not-found answer for a profile that does not exist', async () => {
    const id = insertPerson(db, { name: 'Jordan Hale' })
    const missingFrom = await app.request('/api/admin/people/999999/merge', json('POST', { intoId: id }, { Cookie: admin }))
    expect(missingFrom.status).toBe(404)
    expect(await missingFrom.json()).toEqual({ error: 'Not found' })
    const missingInto = await app.request(`/api/admin/people/${id}/merge`, json('POST', { intoId: 999999 }, { Cookie: admin }))
    expect(missingInto.status).toBe(404)
    expect(await missingInto.json()).toEqual({ error: 'Not found' })
    const missingStaff = await app.request('/api/admin/people/999999/staff', { method: 'POST', headers: { Cookie: admin } })
    expect(missingStaff.status).toBe(404)
    expect(await missingStaff.json()).toEqual({ error: 'Not found' })
    expect(getPerson(db, id)).toBeDefined()
  })
})

describe('rebuilding the wall', () => {
  it('answers a failure with a Hebrew 500 and logs it', async () => {
    // A data folder that is really a file: the wall's tiles cannot be written.
    const dir = tempDir()
    const blocked = path.join(dir, 'not-a-folder')
    fs.writeFileSync(blocked, '')
    const siteDb = openDb(dir)
    insertPerson(siteDb, { name: 'Jenny Carter' })
    const site = createApp({ ...config, dataDir: blocked }, siteDb)
    const cookie = await login('admin-pass', '10.61.2.1', site)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await site.request('/api/admin/rebuild-wall', { method: 'POST', headers: { Cookie: cookie } })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'לא הצלחנו לבנות את הקיר מחדש' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    expect(siteDb.prepare(`SELECT COUNT(*) AS n FROM scenes WHERE kind = 'mosaic'`).get()).toEqual({ n: 0 })
  })
})

describe('backup export', () => {
  it('includes the photos list, quotes, comments, reactions, tapes, videos and credits', async () => {
    const owner = insertPerson(db, { name: 'Sam Carter' })
    db.prepare(`INSERT INTO person_photos (person_id, kind, path) VALUES (?, 'then', 'uploads/sam-then.webp')`).run(owner)
    const quote = Number(db.prepare(`INSERT INTO quotes (text, said_by) VALUES ('Open your books to page 42', 'The teacher')`).run().lastInsertRowid)
    db.prepare(`INSERT INTO quote_comments (quote_id, message, added_by) VALUES (?, 'Every single day', 'Jenny')`).run(quote)
    reactToQuote(db, quote, 'backup-reactor', { emoji: REACTIONS[0] })
    db.prepare(`INSERT INTO tapes (provider, kind, external_id, title) VALUES ('youtube', 'video', 'bkpVideo001', 'Backup song')`).run()
    db.prepare(`INSERT INTO videos (provider, external_id, title) VALUES ('youtube', 'bkpClip0001', 'Backup clip')`).run()
    saveCredits(db, { credits: [{ name: 'Jenny Carter', note: 'Scanned the yearbook' }] })

    const res = await app.request('/api/admin/export', { headers: { Cookie: admin } })
    expect(res.status).toBe(200)
    const backup = await res.json()
    expect(backup.person_photos).toContainEqual(expect.objectContaining({ person_id: owner, kind: 'then', path: 'uploads/sam-then.webp' }))
    expect(backup.quotes).toContainEqual(expect.objectContaining({ id: quote, text: 'Open your books to page 42', said_by: 'The teacher' }))
    expect(backup.quote_comments).toContainEqual(expect.objectContaining({ quote_id: quote, message: 'Every single day', added_by: 'Jenny' }))
    expect(backup.quote_reactions).toContainEqual(expect.objectContaining({ quote_id: quote, reactor: 'backup-reactor', emoji: REACTIONS[0] }))
    expect(backup.tapes).toContainEqual(expect.objectContaining({ provider: 'youtube', external_id: 'bkpVideo001', title: 'Backup song' }))
    expect(backup.videos).toContainEqual(expect.objectContaining({ provider: 'youtube', external_id: 'bkpClip0001', title: 'Backup clip' }))
    expect(backup.credits).toEqual([{ name: 'Jenny Carter', note: 'Scanned the yearbook' }])
    for (const table of ['person_photos', 'quotes', 'quote_comments', 'quote_reactions', 'tapes', 'videos']) expect(backup[table]).toHaveLength(count(table))
  })
})
