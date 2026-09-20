import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { insertPerson } from '../server/people.ts'

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

describe('admin overview', () => {
  it('is for organizers only', async () => {
    expect((await app.request('/api/admin/stats', { headers: { Cookie: member } })).status).toBe(403)
  })

  it('counts people, notes and feedback without revealing what the notes say', async () => {
    const dana = insertPerson(db, { name: 'Dana', attending: 'yes', claimed_at: '2026-09-18T00:00:00Z' })
    insertPerson(db, { name: 'Noa', attending: 'maybe', in_memoriam: 1 })
    db.prepare('INSERT INTO notes (recipient_id, message) VALUES (?, ?)').run(dana, 'A secret only Dana should read')
    db.prepare('INSERT INTO feedback (message) VALUES (?)').run('Great site')

    const res = await app.request('/api/admin/stats', { headers: { Cookie: admin } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({
      people: 2,
      claimed: 1,
      withPin: 0,
      inMemoriam: 1,
      attending: { yes: 1, maybe: 1, no: 0 },
      faces: 0,
      facesNamed: 0,
      notes: 1,
      notesUnread: 1,
      feedback: 1,
      visits: 2,
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
    expect(backup.people.length).toBe((db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n)
    expect(backup.scenes).toEqual([expect.objectContaining({ id: scene, title: 'Prom', kind: 'group' })])
    expect(backup.tags).toEqual([
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
    expect((await put(admin, { credits: [{ name: '  ' }] })).status).toBe(400)
    expect((await put(admin, { credits: [{ name: 'x'.repeat(61) }] })).status).toBe(400)
    expect((await put(admin, { credits: 'nope' })).status).toBe(400)
    expect(await credits(member)).toEqual([{ name: 'רק אני' }])
  })

  it('is closed to members', async () => {
    expect((await put(member, { credits: [] })).status).toBe(403)
  })
})
