import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { getPerson, insertPerson } from '../server/people.ts'
import { exportRoster, importRoster, type RosterFile } from '../server/roster.ts'
import { insertTag, titleYear } from '../server/scenes.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-roster-test-'))
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
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.0.7' },
    body: JSON.stringify({ passcode }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]
}

function addScene(title: string, width = 1000): number {
  const result = db
    .prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort, year) VALUES (?, ?, 'group', ?, 800, ?, 1, ?)`)
    .run(`s-${title}`, title, width, `scenes/s-${title}`, titleYear(title))
  return Number(result.lastInsertRowid)
}

const tagRow = (id: number) => db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as Record<string, unknown>
const json = (cookie: string, body: unknown, method = 'POST') => ({
  method,
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

let member: string
let admin: string
let scene93: number
let scene96: number
let kid93: number
let kid96: number
let teacher: number
let named: number
let alreadyHere: number

const roster: RosterFile = {
  version: 1,
  people: [
    { key: 'a', name: 'י. ישראלי', gender: 'f' },
    { key: 'b', name: 'Someone Else', gender: 'm' },
  ],
  scenes: [
    {
      title: 'a different title',
      year: 1993,
      // Exported from a copy where this picture was twice as big.
      width: 2000,
      height: 1600,
      faces: [{ x: 200, y: 200, w: 100, h: 120, caption: 'י. ישראלי', classLabel: "ט'-2", staff: false, person: 'a' }],
    },
    {
      title: '1996 - graduation',
      year: 1996,
      width: 1000,
      height: 800,
      faces: [
        { x: 302, y: 298, w: 50, h: 60, caption: 'י. ישראלי', classLabel: 'י"ב-3', staff: false, person: 'a' },
        { x: 500, y: 100, w: 50, h: 60, caption: 'The Principal', classLabel: null, staff: true, person: null },
        { x: 700, y: 100, w: 50, h: 60, caption: 'ס. אחר', classLabel: 'י"ב-1', staff: false, person: 'b' },
        { x: 5, y: 5, w: 10, h: 10, caption: 'nobody here', classLabel: null, staff: false, person: null },
      ],
    },
  ],
}

beforeAll(async () => {
  member = await login('class-pass')
  admin = await login('admin-pass')
  scene93 = addScene('1993 - junior high')
  scene96 = addScene('1996 - graduation')
  kid93 = insertTag(db, scene93, { x: 100, y: 100, w: 50, h: 60 }, null)
  kid96 = insertTag(db, scene96, { x: 300, y: 300, w: 50, h: 60 }, null)
  teacher = insertTag(db, scene96, { x: 500, y: 100, w: 50, h: 60 }, null)
  alreadyHere = insertPerson(db, { name: 'Named By A Classmate', claimed_at: '2026-09-18T00:00:00Z' })
  named = insertTag(db, scene96, { x: 700, y: 100, w: 50, h: 60 }, alreadyHere)
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('roster import', () => {
  it('reads the year off a picture title', () => {
    expect(titleYear('1996 - graduation')).toBe(1996)
    expect(titleYear('The wall')).toBeNull()
  })

  it('is for organizers only', async () => {
    expect((await app.request('/api/admin/roster/import', json(member, roster))).status).toBe(403)
    expect((await app.request('/api/admin/roster/export', { headers: { Cookie: member } })).status).toBe(403)
  })

  it('rejects a file that is not a roster', async () => {
    expect((await app.request('/api/admin/roster/import', json(admin, { people: 'nope' }))).status).toBe(400)
  })

  it('matches faces by picture and position, and one person across the years becomes one profile', async () => {
    const res = await app.request('/api/admin/roster/import', json(admin, roster))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ facesMatched: 4, facesUnmatched: 1, peopleAdded: 1, peopleUpdated: 1, namesKept: 1 })

    const personId = tagRow(kid93).person_id as number
    expect(personId).toBeTruthy()
    expect(tagRow(kid96).person_id).toBe(personId)
    expect(getPerson(db, personId)).toMatchObject({ name: 'י. ישראלי', gender: 'f' })
    expect(tagRow(kid93)).toMatchObject({ caption: 'י. ישראלי', class_label: "ט'-2", is_staff: 0 })
    expect(tagRow(kid96)).toMatchObject({ class_label: 'י"ב-3' })
    expect(tagRow(teacher)).toMatchObject({ caption: 'The Principal', is_staff: 1, person_id: null })
  })

  it('keeps a name a classmate already gave, and never renames a claimed profile', () => {
    expect(tagRow(named)).toMatchObject({ person_id: alreadyHere, class_label: 'י"ב-1' })
    expect(getPerson(db, alreadyHere)).toMatchObject({ name: 'Named By A Classmate', gender: 'm' })
  })

  it('never replaces a name somebody typed with a poster caption, but a corrected caption does replace a caption', () => {
    const typed = insertPerson(db, { name: 'Dana Typed-Fullname' })
    const caption = insertPerson(db, { name: 'ד. פלוני' })
    const a = insertTag(db, scene93, { x: 100, y: 500, w: 50, h: 60 }, typed)
    const b = insertTag(db, scene93, { x: 300, y: 500, w: 50, h: 60 }, caption)
    const result = importRoster(db, {
      version: 1,
      people: [
        { key: 't', name: 'ד. טייפד', gender: null },
        { key: 'c', name: 'דנה פלוני', gender: null },
      ],
      scenes: [
        {
          title: '1993 - junior high',
          year: 1993,
          width: 1000,
          height: 800,
          faces: [
            { x: 100, y: 500, w: 50, h: 60, caption: 'ד. טייפד', classLabel: null, staff: false, person: 't' },
            { x: 300, y: 500, w: 50, h: 60, caption: 'ד. פלוני', classLabel: null, staff: false, person: 'c' },
          ],
        },
      ],
    })
    expect(result).toMatchObject({ peopleAdded: 0, peopleUpdated: 1 })
    expect(getPerson(db, typed)!.name).toBe('Dana Typed-Fullname')
    expect(getPerson(db, caption)!.name).toBe('דנה פלוני')
    db.prepare('DELETE FROM tags WHERE id IN (?, ?)').run(a, b)
    db.prepare('DELETE FROM people WHERE id IN (?, ?)').run(typed, caption)
  })

  it('can be run again without adding anyone twice', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
    expect(importRoster(db, roster)).toMatchObject({ peopleAdded: 0, namesKept: 3 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n).toBe(before)
  })

  it('exports what it imported', () => {
    const file = exportRoster(db)
    expect(file.scenes.map((s) => s.year)).toEqual([1993, 1996])
    const israeli = file.people.find((p) => p.name === 'י. ישראלי')!
    expect(israeli.gender).toBe('f')
    expect(file.scenes.flatMap((s) => s.faces).filter((f) => f.person === israeli.key)).toHaveLength(2)
    expect(file.scenes[1].faces.find((f) => f.staff)).toMatchObject({ caption: 'The Principal', person: null })
  })
})

describe('staff faces', () => {
  it('are left out of the yearbook but shown to the roster tool', async () => {
    const scenes = (await (await app.request('/api/scenes', { headers: { Cookie: member } })).json()) as { id: number; year: number; tags: { id: number; classLabel: string }[] }[]
    const s96 = scenes.find((s) => s.id === scene96)!
    expect(s96.year).toBe(1996)
    expect(s96.tags.map((t) => t.id)).not.toContain(teacher)
    expect(s96.tags.find((t) => t.id === kid96)!.classLabel).toBe('י"ב-3')

    expect((await app.request('/api/admin/scenes', { headers: { Cookie: member } })).status).toBe(403)
    const all = (await (await app.request('/api/admin/scenes', { headers: { Cookie: admin } })).json()) as { id: number; tags: { id: number; staff: boolean }[] }[]
    expect(all.find((s) => s.id === scene96)!.tags.find((t) => t.id === teacher)!.staff).toBe(true)
  })

  it('are not counted as faces waiting for a name', async () => {
    const stats = (await (await app.request('/api/admin/stats', { headers: { Cookie: admin } })).json()) as { faces: number; facesNamed: number }
    expect(stats).toMatchObject({ faces: 3, facesNamed: 3 })
  })

  it('a teacher who got a profile can be marked as staff: the faces are hidden and the profile goes', async () => {
    const id = insertPerson(db, { name: 'Mr. Teacher' })
    const face = insertTag(db, scene93, { x: 600, y: 600, w: 50, h: 60 }, id)
    expect((await app.request(`/api/admin/people/${id}/staff`, { method: 'POST', headers: { Cookie: admin } })).status).toBe(200)
    expect(getPerson(db, id)).toBeUndefined()
    expect(tagRow(face)).toMatchObject({ is_staff: 1, person_id: null, caption: 'Mr. Teacher' })

    // And back: not staff after all, with a profile named after the caption.
    const res = await app.request(`/api/admin/tags/${face}/new-person`, json(admin, {}))
    expect(res.status).toBe(201)
    const person = (await res.json()) as { id: number; name: string }
    expect(person.name).toBe('Mr. Teacher')
    expect(tagRow(face)).toMatchObject({ is_staff: 0, person_id: person.id })
  })

  it('a claimed profile cannot be marked as staff', async () => {
    expect((await app.request(`/api/admin/people/${alreadyHere}/staff`, { method: 'POST', headers: { Cookie: admin } })).status).toBe(400)
  })
})

describe('fixing the roster', () => {
  it('edits the caption, class and staff mark of a face', async () => {
    const res = await app.request(`/api/admin/tags/${kid93}`, json(admin, { caption: ' י. ישראלי ', classLabel: "ט'-5" }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ caption: 'י. ישראלי', classLabel: "ט'-5", staff: false })
  })

  it('merges two profiles of one person, moving the faces and keeping the gender', async () => {
    const into = tagRow(kid93).person_id as number
    const from = insertPerson(db, { name: 'י. ישראלית', gender: 'f' })
    const face = insertTag(db, scene93, { x: 800, y: 600, w: 50, h: 60 }, from)
    const res = await app.request(`/api/admin/people/${from}/merge`, json(admin, { intoId: into }))
    expect(res.status).toBe(200)
    expect(getPerson(db, from)).toBeUndefined()
    expect(tagRow(face).person_id).toBe(into)
  })

  it('never merges a claimed profile away', async () => {
    const into = tagRow(kid93).person_id as number
    expect((await app.request(`/api/admin/people/${alreadyHere}/merge`, json(admin, { intoId: into }))).status).toBe(400)
    expect(getPerson(db, alreadyHere)).toBeDefined()
  })

  it('lets organizers set a gender, and rejects anything else', async () => {
    const id = tagRow(kid93).person_id as number
    expect((await app.request(`/api/admin/people/${id}`, json(admin, { gender: 'm' }, 'PATCH'))).status).toBe(200)
    expect(getPerson(db, id)!.gender).toBe('m')
    expect((await app.request(`/api/admin/people/${id}`, json(admin, { gender: 'x' }, 'PATCH'))).status).toBe(400)
  })
})
