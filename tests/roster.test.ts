import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { addPhoto, getPerson, insertPerson, MAX_PHOTOS_PER_KIND } from '../server/people.ts'
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
const peopleCount = () => (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
const picture = () => sharp({ create: { width: 60, height: 60, channels: 3, background: '#ec4899' } }).png().toBuffer()
const onDisk = (rel: string) => fs.existsSync(path.join(dataDir, rel))
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
  // The other faces the roster file names, for the tests that import it into these two pictures.
  insertTag(db, scene96, { x: 300, y: 300, w: 50, h: 60 }, null)
  insertTag(db, scene96, { x: 500, y: 100, w: 50, h: 60 }, null)
  // A poster-style name, so only the claim keeps the file from renaming it.
  alreadyHere = insertPerson(db, { name: 'ס. אחר', claimed_at: '2026-09-18T00:00:00Z' })
  insertTag(db, scene96, { x: 700, y: 100, w: 50, h: 60 }, alreadyHere)
})

/**
 * Two pictures of their own with the faces `roster` names, one already named by a claimed classmate, and the file to
 * import into them. For the tests that check what a first import does, so none depends on another test's import.
 * The pictures, their faces and the profiles on them are deleted when the test ends.
 */
function freshPictures() {
  // Years no other picture here has, so the file's first picture, whose title is not here, is taken by year.
  const junior = addScene('1983 - junior high')
  const graduation = addScene('1986 - graduation')
  const kidJunior = insertTag(db, junior, { x: 100, y: 100, w: 50, h: 60 }, null)
  const kidGraduation = insertTag(db, graduation, { x: 300, y: 300, w: 50, h: 60 }, null)
  const principal = insertTag(db, graduation, { x: 500, y: 100, w: 50, h: 60 }, null)
  // A poster-style name, so only the claim keeps the file from renaming it.
  const classmate = insertPerson(db, { name: 'ס. אחר', claimed_at: '2026-09-18T00:00:00Z' })
  const named = insertTag(db, graduation, { x: 700, y: 100, w: 50, h: 60 }, classmate)
  const file: RosterFile = {
    ...roster,
    scenes: [{ ...roster.scenes[0], year: 1983 }, { ...roster.scenes[1], title: '1986 - graduation', year: 1986 }],
  }
  onTestFinished(() => {
    const people = db.prepare('SELECT DISTINCT person_id FROM tags WHERE scene_id IN (?, ?) AND person_id IS NOT NULL').all(junior, graduation) as { person_id: number }[]
    db.prepare('DELETE FROM scenes WHERE id IN (?, ?)').run(junior, graduation)
    for (const { person_id } of people) db.prepare('DELETE FROM people WHERE id = ?').run(person_id)
  })
  return { file, graduation, kidJunior, kidGraduation, principal, named, classmate }
}

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
    const { file, kidJunior, kidGraduation, principal } = freshPictures()
    const res = await app.request('/api/admin/roster/import', json(admin, file))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ facesMatched: 4, facesUnmatched: 1, peopleAdded: 1, peopleUpdated: 1, namesKept: 1 })

    const personId = tagRow(kidJunior).person_id as number
    expect(personId).toBeTruthy()
    expect(tagRow(kidGraduation).person_id).toBe(personId)
    expect(getPerson(db, personId)).toMatchObject({ name: 'י. ישראלי', gender: 'f' })
    expect(tagRow(kidJunior)).toMatchObject({ caption: 'י. ישראלי', class_label: "ט'-2", is_staff: 0 })
    expect(tagRow(kidGraduation)).toMatchObject({ class_label: 'י"ב-3' })
    expect(tagRow(principal)).toMatchObject({ caption: 'The Principal', is_staff: 1, person_id: null })
  })

  it('keeps a name a classmate already gave, and never renames a claimed profile', () => {
    const { file, named, classmate } = freshPictures()
    importRoster(db, file)
    expect(tagRow(named)).toMatchObject({ person_id: classmate, class_label: 'י"ב-1' })
    expect(getPerson(db, classmate)).toMatchObject({ name: 'ס. אחר', gender: 'm' })
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

  it('keeps a name a classmate gave even when the file marks that face as staff', () => {
    const me = insertPerson(db, { name: 'Tamar Said That Is Me', claimed_at: '2026-09-20T00:00:00Z' })
    const face = insertTag(db, scene93, { x: 100, y: 700, w: 50, h: 60 }, me)
    const result = importRoster(db, {
      version: 1,
      people: [],
      scenes: [
        {
          title: '1993 - junior high',
          year: 1993,
          width: 1000,
          height: 800,
          faces: [{ x: 100, y: 700, w: 50, h: 60, caption: 'The Gym Teacher', classLabel: null, staff: true, person: null }],
        },
      ],
    })
    expect(result).toMatchObject({ facesMatched: 1, namesKept: 1 })
    expect(tagRow(face)).toMatchObject({ person_id: me, is_staff: 0 })
    db.prepare('DELETE FROM tags WHERE id = ?').run(face)
    db.prepare('DELETE FROM people WHERE id = ?').run(me)
  })

  it('leaves a caption and class typed here alone when the file has none', () => {
    const kid = insertTag(db, scene93, { x: 300, y: 700, w: 50, h: 60 }, null)
    const staff = insertTag(db, scene93, { x: 500, y: 700, w: 50, h: 60 }, null)
    db.prepare('UPDATE tags SET caption = ?, class_label = ? WHERE id = ?').run('ר. מקומי', 'י"ב-4', kid)
    db.prepare('UPDATE tags SET caption = ?, is_staff = 1 WHERE id = ?').run('המורה לספורט', staff)
    importRoster(db, {
      version: 1,
      people: [],
      scenes: [
        {
          title: '1993 - junior high',
          year: 1993,
          width: 1000,
          height: 800,
          faces: [
            { x: 300, y: 700, w: 50, h: 60, caption: null, classLabel: null, staff: false, person: null },
            { x: 500, y: 700, w: 50, h: 60, caption: null, classLabel: null, staff: true, person: null },
          ],
        },
      ],
    })
    expect(tagRow(kid)).toMatchObject({ caption: 'ר. מקומי', class_label: 'י"ב-4' })
    expect(tagRow(staff)).toMatchObject({ caption: 'המורה לספורט', is_staff: 1 })
    db.prepare('DELETE FROM tags WHERE id IN (?, ?)').run(kid, staff)
  })

  it('never gives one face here to two pictures in the file', () => {
    const face = insertTag(db, scene96, { x: 100, y: 600, w: 50, h: 60 }, null)
    const before = peopleCount()
    // Neither title is on this site, so both would fall back to its one 1996 picture.
    const shot = (title: string, person: string) => ({
      title,
      year: 1996,
      width: 1000,
      height: 800,
      faces: [{ x: 100, y: 600, w: 50, h: 60, caption: null, classLabel: null, staff: false, person }],
    })
    const result = importRoster(db, {
      version: 1,
      people: [
        { key: 'x', name: 'א. ראשון', gender: null },
        { key: 'y', name: 'ב. שני', gender: null },
      ],
      scenes: [shot('1996 - trip', 'x'), shot('1996 - party', 'y')],
    })
    expect(result).toMatchObject({ facesMatched: 1, facesUnmatched: 1, peopleAdded: 1 })
    expect(peopleCount()).toBe(before + 1)
    const added = tagRow(face).person_id as number
    expect(getPerson(db, added)!.name).toBe('א. ראשון')
    db.prepare('DELETE FROM tags WHERE id = ?').run(face)
    db.prepare('DELETE FROM people WHERE id = ?').run(added)
  })

  it('never takes a picture here by year when the file has that picture by name', () => {
    const face = insertTag(db, scene96, { x: 100, y: 600, w: 50, h: 60 }, null)
    const result = importRoster(db, {
      version: 1,
      people: [{ key: 'z', name: 'ז. זר', gender: null }],
      scenes: [
        // Not on this site. Listed first, so the rule cannot depend on the order of the file.
        {
          title: '1996 - trip',
          year: 1996,
          width: 1000,
          height: 800,
          faces: [{ x: 100, y: 600, w: 50, h: 60, caption: 'ז. זר', classLabel: null, staff: false, person: 'z' }],
        },
        // The graduation picture itself, whose one face is not the one above.
        {
          title: '1996 - graduation',
          year: 1996,
          width: 1000,
          height: 800,
          faces: [{ x: 900, y: 700, w: 50, h: 60, caption: null, classLabel: null, staff: false, person: null }],
        },
      ],
    })
    expect(result).toMatchObject({ facesMatched: 0, facesUnmatched: 2, peopleAdded: 0 })
    expect(tagRow(face)).toMatchObject({ person_id: null, caption: null })
    db.prepare('DELETE FROM tags WHERE id = ?').run(face)
  })

  it('still lets a second picture here with the same title be taken by year', () => {
    const twin = Number(
      db
        .prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort, year) VALUES ('s-twin', '1996 - graduation', 'group', 1000, 800, 'scenes/s-twin', 1, 1996)`)
        .run().lastInsertRowid,
    )
    const face = insertTag(db, twin, { x: 100, y: 600, w: 50, h: 60 }, null)
    const result = importRoster(db, {
      version: 1,
      people: [{ key: 'w', name: 'ו. ורד', gender: null }],
      scenes: [
        { title: '1996 - graduation', year: 1996, width: 1000, height: 800, faces: [] },
        {
          title: '1996 - trip',
          year: 1996,
          width: 1000,
          height: 800,
          faces: [{ x: 100, y: 600, w: 50, h: 60, caption: null, classLabel: null, staff: false, person: 'w' }],
        },
      ],
    })
    expect(result).toMatchObject({ facesMatched: 1, peopleAdded: 1 })
    const added = tagRow(face).person_id as number
    expect(getPerson(db, added)!.name).toBe('ו. ורד')
    db.prepare('DELETE FROM scenes WHERE id = ?').run(twin)
    db.prepare('DELETE FROM people WHERE id = ?').run(added)
  })

  it('can be run again without adding anyone twice', () => {
    importRoster(db, roster)
    const before = peopleCount()
    // Every face the file names now has that name here, so each one is kept.
    const namedFaces = roster.scenes.flatMap((s) => s.faces).filter((f) => f.person && !f.staff).length
    expect(importRoster(db, roster)).toMatchObject({ peopleAdded: 0, namesKept: namedFaces })
    expect(peopleCount()).toBe(before)
  })

  it('exports what it imported', () => {
    importRoster(db, roster)
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
    const { file, graduation, kidGraduation, principal } = freshPictures()
    importRoster(db, file)
    const scenes = (await (await app.request('/api/scenes', { headers: { Cookie: member } })).json()) as { id: number; year: number; tags: { id: number; classLabel: string }[] }[]
    const s86 = scenes.find((s) => s.id === graduation)!
    expect(s86.year).toBe(1986)
    expect(s86.tags.map((t) => t.id)).not.toContain(principal)
    expect(s86.tags.find((t) => t.id === kidGraduation)!.classLabel).toBe('י"ב-3')

    expect((await app.request('/api/admin/scenes', { headers: { Cookie: member } })).status).toBe(403)
    const all = (await (await app.request('/api/admin/scenes', { headers: { Cookie: admin } })).json()) as { id: number; tags: { id: number; staff: boolean }[] }[]
    expect(all.find((s) => s.id === graduation)!.tags.find((t) => t.id === principal)!.staff).toBe(true)
  })

  it('are not counted as faces waiting for a name', async () => {
    const stats = async () => (await (await app.request('/api/admin/stats', { headers: { Cookie: admin } })).json()) as { faces: number; facesNamed: number }
    const before = await stats()
    const staff = insertTag(db, scene96, { x: 900, y: 10, w: 50, h: 60 }, null)
    db.prepare('UPDATE tags SET is_staff = 1 WHERE id = ?').run(staff)
    const unnamed = insertTag(db, scene96, { x: 900, y: 200, w: 50, h: 60 }, null)
    try {
      // Only the classmate's face is one more waiting for a name.
      expect(await stats()).toMatchObject({ faces: before.faces + 1, facesNamed: before.facesNamed })
    } finally {
      db.prepare('DELETE FROM tags WHERE id IN (?, ?)').run(staff, unnamed)
    }
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

  it('marking someone as staff deletes their photo files too', async () => {
    const id = insertPerson(db, { name: 'Ms. Photographed Teacher' })
    const photo = await addPhoto(db, dataDir, id, 'now', await picture())
    expect(onDisk(photo.path)).toBe(true)
    expect((await app.request(`/api/admin/people/${id}/staff`, { method: 'POST', headers: { Cookie: admin } })).status).toBe(200)
    expect(getPerson(db, id)).toBeUndefined()
    expect(onDisk(photo.path)).toBe(false)
  })

  it('marking someone as staff that fails part way leaves their photo files in place', async () => {
    const id = insertPerson(db, { name: 'Mr. Rolled Back' })
    const photo = await addPhoto(db, dataDir, id, 'now', await picture())
    // The profile's own delete, the last step, fails.
    db.exec(`CREATE TRIGGER fail_staff BEFORE DELETE ON people WHEN OLD.id = ${id} BEGIN SELECT RAISE(ABORT, 'no'); END`)
    try {
      expect((await app.request(`/api/admin/people/${id}/staff`, { method: 'POST', headers: { Cookie: admin } })).status).toBe(400)
    } finally {
      db.exec('DROP TRIGGER fail_staff')
    }
    expect(getPerson(db, id)!.photos!.map((p) => p.path)).toEqual([photo.path])
    expect(onDisk(photo.path)).toBe(true)
  })

  it('a photo file that cannot be deleted is logged, and marking as staff still goes through', async () => {
    const id = insertPerson(db, { name: 'Ms. Locked File' })
    await addPhoto(db, dataDir, id, 'now', await picture())
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error(`EACCES: permission denied, unlink '${dataDir}/uploads/locked.webp'`)
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request(`/api/admin/people/${id}/staff`, { method: 'POST', headers: { Cookie: admin } })
      expect(res.status).toBe(200)
      expect(await res.text()).not.toContain(dataDir)
      expect(logged).toHaveBeenCalled()
    } finally {
      rm.mockRestore()
      logged.mockRestore()
    }
    expect(getPerson(db, id)).toBeUndefined()
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

  it('merges two profiles of one person, moving the faces, the notes and the gender', async () => {
    const into = insertPerson(db, { name: 'Yoav Levi' })
    const from = insertPerson(db, { name: 'י. לוי', gender: 'm' })
    const face = insertTag(db, scene93, { x: 800, y: 600, w: 50, h: 60 }, from)
    const note = Number(db.prepare('INSERT INTO notes (recipient_id, message) VALUES (?, ?)').run(from, 'For Yoav').lastInsertRowid)
    const res = await app.request(`/api/admin/people/${from}/merge`, json(admin, { intoId: into }))
    expect(res.status).toBe(200)
    expect(getPerson(db, from)).toBeUndefined()
    expect(tagRow(face).person_id).toBe(into)
    expect(getPerson(db, into)!.gender).toBe('m')
    expect(db.prepare('SELECT recipient_id FROM notes WHERE id = ?').get(note)).toEqual({ recipient_id: into })
  })

  it('a merge keeps the photos of both profiles, up to the limit, and deletes the files of the ones left over', async () => {
    const into = insertPerson(db, { name: 'Noa Barak' })
    const from = insertPerson(db, { name: 'נ. ברק' })
    const [intoThen1, intoThen2] = [await addPhoto(db, dataDir, into, 'then', await picture()), await addPhoto(db, dataDir, into, 'then', await picture())]
    const [fromThen1, fromThen2] = [await addPhoto(db, dataDir, from, 'then', await picture()), await addPhoto(db, dataDir, from, 'then', await picture())]
    const fromNow = await addPhoto(db, dataDir, from, 'now', await picture())

    expect((await app.request(`/api/admin/people/${from}/merge`, json(admin, { intoId: into }))).status).toBe(200)
    const merged = getPerson(db, into)!
    const paths = (kind: 'then' | 'now') => merged.photos!.filter((p) => p.kind === kind).map((p) => p.path)
    // Three "then" photos at most: both of Noa's and the first of the other profile's.
    expect(paths('then')).toEqual([intoThen1.path, intoThen2.path, fromThen1.path])
    expect(paths('now')).toEqual([fromNow.path])
    expect(merged).toMatchObject({ then_photo: intoThen1.path, now_photo: fromNow.path })
    expect([intoThen1, intoThen2, fromThen1, fromNow].every((p) => onDisk(p.path))).toBe(true)
    expect(onDisk(fromThen2.path)).toBe(false)
  })

  it('a merge that fails part way leaves every photo file in place', async () => {
    const into = insertPerson(db, { name: 'Roni Tal' })
    const from = insertPerson(db, { name: 'ר. טל' })
    for (let i = 0; i < MAX_PHOTOS_PER_KIND; i++) await addPhoto(db, dataDir, into, 'then', await picture())
    // No room left on the kept profile, so this one is dropped by a merge that goes through.
    const extra = await addPhoto(db, dataDir, from, 'then', await picture())
    db.exec(`CREATE TRIGGER fail_merge BEFORE DELETE ON people WHEN OLD.id = ${from} BEGIN SELECT RAISE(ABORT, 'no'); END`)
    try {
      expect((await app.request(`/api/admin/people/${from}/merge`, json(admin, { intoId: into }))).status).toBe(400)
    } finally {
      db.exec('DROP TRIGGER fail_merge')
    }
    expect(getPerson(db, from)!.photos!.map((p) => p.path)).toEqual([extra.path])
    expect(onDisk(extra.path)).toBe(true)
  })

  it('a merge fills in details the kept profile lacks, and keeps hidden ones hidden', async () => {
    // Hidden on either profile stays hidden: the email was hidden on the merged one, the website on the kept one.
    const into = insertPerson(db, { name: 'Gal Mor', former_name: 'Gal Shani', show_website: 0 })
    const from = insertPerson(db, {
      name: 'ג. מור',
      former_name: 'Gal Other',
      nickname: 'Gali',
      email: 'gal@example.com',
      show_email: 0,
      phone: '050-1234567',
      website: 'https://gal.example.com',
    })
    expect((await app.request(`/api/admin/people/${from}/merge`, json(admin, { intoId: into }))).status).toBe(200)
    expect(getPerson(db, into)).toMatchObject({
      former_name: 'Gal Shani',
      nickname: 'Gali',
      email: 'gal@example.com',
      show_email: 0,
      phone: '050-1234567',
      website: 'https://gal.example.com',
      show_website: 0,
    })
    const everyone = (await (await app.request('/api/people', { headers: { Cookie: member } })).json()) as { id: number; email: string | null; phone: string | null }[]
    expect(everyone.find((p) => p.id === into)).toMatchObject({ email: null, phone: '050-1234567', website: null })
  })

  it('never merges a claimed profile away', async () => {
    const into = tagRow(kid93).person_id as number
    expect((await app.request(`/api/admin/people/${alreadyHere}/merge`, json(admin, { intoId: into }))).status).toBe(400)
    expect(getPerson(db, alreadyHere)).toBeDefined()
  })

  it('lets organizers set a gender, and rejects anything else', async () => {
    const id = insertPerson(db, { name: 'Tal Adler' })
    expect((await app.request(`/api/admin/people/${id}`, json(admin, { gender: 'm' }, 'PATCH'))).status).toBe(200)
    expect(getPerson(db, id)!.gender).toBe('m')
    expect((await app.request(`/api/admin/people/${id}`, json(admin, { gender: 'x' }, 'PATCH'))).status).toBe(400)
  })
})
