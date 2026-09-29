import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminRoutes } from '../server/admin.ts'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { MAX_UPLOAD_BYTES } from '../server/images.ts'
import { getPerson, insertPerson } from '../server/people.ts'

// Pins down how the server behaves today, so a change that breaks one of these guarantees shows up in the tests.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-safety-test-'))
const config: Config = {
  dataDir,
  classPasscode: 'class-pass',
  adminPasscode: 'admin-pass',
  sessionSecret: 'test-secret',
  port: 0,
  webDir: path.join(dataDir, 'web'),
  secureCookies: false,
  publicUrl: 'https://example.test',
}
const db = openDb(dataDir)
const app = createApp(config, db)
const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

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

function fileForm(field: string, file: File, extra: Record<string, string> = {}) {
  const form = new FormData()
  form.set(field, file)
  for (const [k, v] of Object.entries(extra)) form.set(k, v)
  return form
}

async function realPng() {
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#14b8a6' } }).png().toBuffer()
  return new File([new Uint8Array(png)], 'photo.png', { type: 'image/png' })
}

/** A profile made by a classmate, with the edit token that owns it. */
async function ownProfile(member: string, name: string, pin?: string): Promise<{ id: number; token: string }> {
  const res = await app.request('/api/people', json('POST', { name, ...(pin ? { pin } : {}) }, { Cookie: member }))
  expect(res.status).toBe(201)
  const body = await res.json()
  return { id: body.person.id, token: body.token }
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('admin routes are for organizers only', () => {
  type Body = { json: unknown } | { text: string } | { file: string }

  // One row per route registration in server/admin.ts: 32 in all (the admin.get/post/put/patch/delete calls there).
  // Paths are written exactly as registered, so the test below can compare them with the router's own list.
  const ROUTES: [method: string, route: string, body?: Body][] = [
    ['POST', '/people', { json: { name: 'Jenny Carter' } }],
    ['PATCH', '/people/:id', { json: { nickname: 'Jen' } }],
    ['DELETE', '/people/:id'],
    ['POST', '/people/:id/reset-claim'],
    ['POST', '/people/:id/merge', { json: { intoId: 1 } }],
    ['POST', '/people/:id/staff'],
    ['POST', '/people/:id/photo/:kind', { file: 'photo' }],
    ['DELETE', '/people/:id/photo/:photoId'],
    ['POST', '/import-csv', { text: 'name\nJenny Carter' }],
    ['GET', '/scenes'],
    ['POST', '/scenes', { file: 'image' }],
    ['DELETE', '/scenes/:id'],
    ['POST', '/scenes/:id/tags', { json: { x: 1, y: 1, w: 10, h: 10 } }],
    ['POST', '/scenes/:id/tags/batch', { json: { boxes: [{ x: 1, y: 1, w: 10, h: 10 }] } }],
    ['DELETE', '/scenes/:id/unidentified-tags'],
    ['PATCH', '/tags/:id', { json: { caption: 'Jenny' } }],
    ['POST', '/tags/:id/new-person', { json: { name: 'Jenny Carter' } }],
    ['DELETE', '/tags/:id'],
    ['POST', '/rebuild-wall'],
    ['DELETE', '/tapes/:id'],
    ['DELETE', '/videos/:id'],
    ['DELETE', '/quotes/:id'],
    ['DELETE', '/quote-comments/:id'],
    ['GET', '/version'],
    ['GET', '/stats'],
    ['GET', '/export'],
    ['PUT', '/credits', { json: { credits: [{ name: 'Jenny Carter' }] } }],
    ['GET', '/roster/export'],
    ['POST', '/roster/import', { json: { version: 1, people: [], scenes: [] } }],
    ['GET', '/feedback'],
    ['DELETE', '/feedback/:id'],
    ['POST', '/demo'],
  ]

  let member: string
  let personId: number

  beforeAll(async () => {
    member = await login('class-pass', '10.51.0.1')
    personId = insertPerson(db, { name: 'Casey Morgan' })
  })

  const url = (route: string) =>
    `/api/admin${route.replace(':id', String(personId)).replace(':kind', 'then').replace(':photoId', '1')}`

  function init(method: string, body: Body | undefined, headers: Record<string, string>): RequestInit {
    if (!body) return { method, headers }
    if ('json' in body) return json(method, body.json, headers)
    if ('text' in body) return { method, headers: { 'Content-Type': 'text/csv', ...headers }, body: body.text }
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'tiny.png', { type: 'image/png' })
    return { method, headers, body: fileForm(body.file, file, { title: 'Class photo' }) }
  }

  it('lists every registered admin route', () => {
    const registered = adminRoutes(config, db)
      .routes.filter((r) => !(r.method === 'ALL' && r.path === '/*'))
      .map((r) => `${r.method} ${r.path}`)
    expect(ROUTES.map(([method, route]) => `${method} ${route}`).sort()).toEqual([...registered].sort())
  })

  it('answers a classmate with 403 on every one, and changes nothing', async () => {
    const people = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
    for (const [method, route, body] of ROUTES) {
      const res = await app.request(url(route), init(method, body, { Cookie: member }))
      expect(res.status, `${method} ${route}`).toBe(403)
      expect(await res.json(), `${method} ${route}`).toEqual({ error: 'למארגנים בלבד' })
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n).toBe(people)
    expect(getPerson(db, personId)?.name).toBe('Casey Morgan')
  })

  it('answers a visitor without a session with 401 on every one', async () => {
    for (const [method, route, body] of ROUTES) {
      const res = await app.request(url(route), init(method, body, {}))
      expect(res.status, `${method} ${route}`).toBe(401)
      expect(await res.json(), `${method} ${route}`).toEqual({ error: 'נדרשת סיסמה' })
    }
  })
})

describe('session cookie', () => {
  const COOKIE = 'reunion_session'
  const split = (cookie: string) => {
    const value = decodeURIComponent(cookie.slice(`${COOKIE}=`.length))
    const dot = value.lastIndexOf('.')
    return { payload: value.slice(0, dot), signature: value.slice(dot + 1) }
  }
  const join = (payload: string, signature: string) => `${COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}`
  const role = async (cookie: string) => (await (await app.request('/api/session', { headers: { Cookie: cookie } })).json()).role
  const people = async (cookie: string) => (await app.request('/api/people', { headers: { Cookie: cookie } })).status

  let member: string

  beforeAll(async () => {
    member = await login('class-pass', '10.52.0.1')
  })

  it('works as issued', async () => {
    expect(await role(member)).toBe('member')
    expect(await people(member)).toBe(200)
  })

  it('treats a cookie whose role was changed as no session', async () => {
    const { payload, signature } = split(member)
    expect(payload).toContain('member')
    const forged = join(payload.replace('member', 'admin'), signature)
    expect(forged).not.toBe(member)
    expect(await role(forged)).toBeNull()
    expect(await people(forged)).toBe(401)
    expect((await app.request('/api/admin/stats', { headers: { Cookie: forged } })).status).toBe(401)
  })

  it('treats a cookie with a changed signature as no session', async () => {
    const { payload, signature } = split(member)
    // The first character, not the last: the last one before the padding carries bits that decoding ignores.
    const forged = join(payload, `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`)
    expect(await role(forged)).toBeNull()
    expect(await people(forged)).toBe(401)
  })

  it('treats a cookie with no signature as no session', async () => {
    const { payload } = split(member)
    const unsigned = `${COOKIE}=${encodeURIComponent(payload)}`
    expect(await role(unsigned)).toBeNull()
    expect(await people(unsigned)).toBe(401)
  })

  it('treats a cookie signed with another secret as no session', async () => {
    const other = createApp({ ...config, sessionSecret: 'another-secret' }, db)
    const foreign = await login('admin-pass', '10.52.0.2', other)
    expect(await role(foreign)).toBeNull()
    expect(await people(foreign)).toBe(401)
  })

  it('lasts 90 days, then counts as no session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const cookie = await login('class-pass', '10.52.0.3')
      const admin = await login('admin-pass', '10.52.0.3')

      vi.setSystemTime(start + 89 * DAY)
      expect(await role(cookie)).toBe('member')
      expect(await people(cookie)).toBe(200)
      expect((await app.request('/api/admin/stats', { headers: { Cookie: admin } })).status).toBe(200)

      vi.setSystemTime(start + 91 * DAY)
      expect(await role(cookie)).toBeNull()
      expect(await people(cookie)).toBe(401)
      expect(await role(admin)).toBeNull()
      expect((await app.request('/api/admin/stats', { headers: { Cookie: admin } })).status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('profile photo uploads', () => {
  let member: string

  beforeAll(async () => {
    member = await login('class-pass', '10.53.0.1')
  })

  const upload = (token: string | null, kind: string, file: File) =>
    app.request(`/api/me/photo/${kind}`, {
      method: 'POST',
      headers: { Cookie: member, ...(token ? { 'x-edit-token': token } : {}) },
      body: fileForm('photo', file),
    })
  const nowPhotos = (id: number) => (db.prepare("SELECT COUNT(*) AS n FROM person_photos WHERE person_id = ? AND kind = 'now'").get(id) as { n: number }).n

  it('accepts a real PNG and serves it back', async () => {
    const { id, token } = await ownProfile(member, 'Riley Brooks')
    const res = await upload(token, 'now', await realPng())
    expect(res.status).toBe(200)
    const person = await res.json()
    expect(person.nowPhotos).toHaveLength(1)
    expect(person.nowPhoto).toMatch(/^\/media\/uploads\/.+\.webp$/)
    expect(nowPhotos(id)).toBe(1)
    const media = await app.request(person.nowPhoto, { headers: { Cookie: member } })
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/webp')
  })

  it('refuses a file that is not an image', async () => {
    const { id, token } = await ownProfile(member, 'Riley Brooks')
    const res = await upload(token, 'now', new File(['just some text'], 'notes.txt', { type: 'text/plain' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'הקובץ חייב להיות תמונה' })
    expect(nowPhotos(id)).toBe(0)
  })

  it('refuses bytes that only claim to be an image', async () => {
    const { id, token } = await ownProfile(member, 'Riley Brooks')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await upload(token, 'now', new File(['not really a png'], 'fake.png', { type: 'image/png' }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'הקובץ אינו תמונה תקינה' })
      // The image library's own message goes to the log, not to the classmate.
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
    expect(nowPhotos(id)).toBe(0)
  })

  it('refuses a photo just over the upload cap in the handler, with 400', async () => {
    const { id, token } = await ownProfile(member, 'Riley Brooks')
    const res = await upload(token, 'now', new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.png', { type: 'image/png' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'התמונה גדולה מדי (עד 10MB)' })
    expect(nowPhotos(id)).toBe(0)
  })

  it('refuses a body over the route limit with 413', async () => {
    const { id, token } = await ownProfile(member, 'Riley Brooks')
    const res = await upload(token, 'now', new File([new Uint8Array(MAX_UPLOAD_BYTES + MB + 1)], 'huge.png', { type: 'image/png' }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'הקובץ או הבקשה גדולים מדי' })
    expect(nowPhotos(id)).toBe(0)
  })

  it('refuses an upload without an edit token, or to an unknown kind', async () => {
    const { token } = await ownProfile(member, 'Riley Brooks')
    const anonymous = await upload(null, 'now', await realPng())
    expect(anonymous.status).toBe(403)
    expect(await anonymous.json()).toEqual({ error: 'קישור העריכה אינו תקף' })
    const unknownKind = await upload(token, 'later', await realPng())
    expect(unknownKind.status).toBe(400)
    expect(await unknownKind.json()).toEqual({ error: 'סוג תמונה לא מוכר' })
  })
})

describe('PIN sign-in limit per address', () => {
  const ipA = '10.54.0.1'
  const ipB = '10.54.0.2'
  let member: string

  beforeAll(async () => {
    member = await login('class-pass', '10.54.0.100')
  })

  const pinLogin = (id: number, pin: string, ip: string) =>
    app.request(`/api/people/${id}/login`, json('POST', { pin }, { Cookie: member, 'x-real-ip': ip }))

  it('blocks an address after 10 wrong PINs, even with the right one, and leaves other addresses alone', async () => {
    // Spread over two profiles, so neither profile reaches the limit on its own and only the address is blocked.
    const first = await ownProfile(member, 'Avery Lane', '2468')
    const second = await ownProfile(member, 'Jordan Hale', '1357')
    for (const id of [first.id, second.id]) {
      for (let i = 0; i < 5; i++) {
        const res = await pinLogin(id, '0000', ipA)
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'הקוד לא נכון' })
      }
    }

    const blocked = await pinLogin(first.id, '2468', ipA)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' })
    expect((await pinLogin(second.id, '1357', ipA)).status).toBe(429)

    const elsewhere = await pinLogin(first.id, '2468', ipB)
    expect(elsewhere.status).toBe(200)
    expect(typeof (await elsewhere.json()).token).toBe('string')
  })
})

describe('GET /api/session', () => {
  it('is null without a session', async () => {
    const res = await app.request('/api/session')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: null })
  })

  it('names the member role for the class passcode', async () => {
    const res = await app.request('/api/session', { headers: { Cookie: await login('class-pass', '10.55.0.1') } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'member' })
  })

  it('names the admin role for the admin passcode', async () => {
    const res = await app.request('/api/session', { headers: { Cookie: await login('admin-pass', '10.55.0.2') } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'admin' })
  })
})

describe('in memoriam profiles', () => {
  let member: string
  let remembered: number
  let control: number

  beforeAll(async () => {
    member = await login('class-pass', '10.56.0.1')
    remembered = insertPerson(db, { name: 'Ruth Avery', in_memoriam: 1 })
    control = insertPerson(db, { name: 'Owen Price' })
  })

  const notesTo = (id: number) => (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE recipient_id = ?').get(id) as { n: number }).n

  it('cannot be claimed, while an ordinary unclaimed profile can', async () => {
    const refused = await app.request(`/api/people/${remembered}/claim`, json('POST', { pin: '2468' }, { Cookie: member }))
    expect(refused.status).toBe(409)
    expect(typeof (await refused.json()).error).toBe('string')
    expect(getPerson(db, remembered)?.claimed_at).toBeNull()
    expect(getPerson(db, remembered)?.edit_token_hash).toBeNull()

    const claimed = await app.request(`/api/people/${control}/claim`, json('POST', { pin: '2468' }, { Cookie: member }))
    expect(claimed.status).toBe(200)
  })

  it('gets no notes, anonymous or signed, while an ordinary profile does', async () => {
    const anonymous = await app.request('/api/notes', json('POST', { to: remembered, message: 'Thinking of you', anonymous: true }, { Cookie: member }))
    expect(anonymous.status).toBe(400)
    expect(await anonymous.json()).toEqual({ error: 'אי אפשר לשלוח פתק לפרופיל הזה' })

    const sender = await ownProfile(member, 'Dana Ellis')
    const signed = await app.request('/api/notes', json('POST', { to: remembered, message: 'Thinking of you' }, { Cookie: member, 'x-edit-token': sender.token }))
    expect(signed.status).toBe(400)
    expect(await signed.json()).toEqual({ error: 'אי אפשר לשלוח פתק לפרופיל הזה' })
    expect(notesTo(remembered)).toBe(0)

    const ordinary = await app.request('/api/notes', json('POST', { to: control, message: 'See you there', anonymous: true }, { Cookie: member }))
    expect(ordinary.status).toBe(201)
    expect(notesTo(control)).toBe(1)
  })

  it('ignores inMemoriam from a classmate, on their own profile and on a new one', async () => {
    const own = await ownProfile(member, 'Sam Carter')
    const patched = await app.request('/api/me', json('PATCH', { inMemoriam: true, city: 'Haifa' }, { Cookie: member, 'x-edit-token': own.token }))
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ inMemoriam: false, city: 'Haifa' })
    expect(getPerson(db, own.id)?.in_memoriam).toBe(0)

    const created = await app.request('/api/people', json('POST', { name: 'Lee Porter', inMemoriam: true }, { Cookie: member }))
    expect(created.status).toBe(201)
    expect((await created.json()).person.inMemoriam).toBe(false)
  })
})
