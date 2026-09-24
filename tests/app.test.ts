import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { MAX_PHOTOS_PER_KIND, insertPerson, parsePersonInput } from '../server/people.ts'
import { addTape, parseTapeLink } from '../server/tapes.ts'
import { addVideo, albumVideoEntries, formatDuration, listVideos, parseVideoLink } from '../server/videos.ts'
import { addFeedback, feedbackSender, type SendEmail } from '../server/feedback.ts'
import { configuredMailer, gmailRelayMailer, type Mailer } from '../server/email.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-test-'))
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

async function login(passcode: string, ip = '10.0.0.1'): Promise<string> {
  const res = await app.request('/api/login', {
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

async function pngUpload(field: string, extra: Record<string, string> = {}) {
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#ec4899' } }).png().toBuffer()
  const form = new FormData()
  form.set(field, new File([new Uint8Array(png)], 'photo.png', { type: 'image/png' }))
  for (const [k, v] of Object.entries(extra)) form.set(k, v)
  return form
}

let member: string
let admin: string
let personId: number

beforeAll(async () => {
  member = await login('class-pass')
  admin = await login('admin-pass')
  personId = insertPerson(db, { name: 'Jenny Carter', email: 'jenny@example.com', show_email: 0 })
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('passcode gate', () => {
  it('blocks the API and media without a session', async () => {
    for (const url of ['/api/people', '/api/scenes', '/api/event', '/media/uploads/x.webp', '/api/admin/people']) {
      expect((await app.request(url)).status, url).toBe(401)
    }
  })

  it('rejects a wrong passcode and a forged cookie', async () => {
    const res = await app.request('/api/login', json('POST', { passcode: 'nope' }, { 'x-real-ip': '10.0.0.2' }))
    expect(res.status).toBe(401)
    const forged = await app.request('/api/people', { headers: { Cookie: 'reunion_session=admin:9999999999999.bad' } })
    expect(forged.status).toBe(401)
  })

  it('rate limits repeated failures per client', async () => {
    const attempt = () => app.request('/api/login', json('POST', { passcode: 'nope' }, { 'x-real-ip': '10.0.0.3' }))
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401)
    expect((await attempt()).status).toBe(429)
  })

  it('marks every response noindex', async () => {
    expect((await app.request('/healthz')).headers.get('x-robots-tag')).toContain('noindex')
  })

  it('does not serve files outside the media folders', async () => {
    for (const url of ['/media/reunion.db', '/media/uploads/..%2Freunion.db', '/media/scenes/../../etc/passwd']) {
      expect((await app.request(url, { headers: { Cookie: member } })).status, url).toBe(404)
    }
  })
})

describe('event details', () => {
  it('shows the placeholder from content/event.json unless EVENT_JSON is set', async () => {
    const title = async () => ((await (await app.request('/api/event', { headers: { Cookie: member } })).json()) as { title: string }).title
    expect(await title()).toBe('Class Reunion')
    process.env.EVENT_JSON = JSON.stringify({ title: 'The real reunion', music: {}, memories: {} })
    try {
      expect(await title()).toBe('The real reunion')
    } finally {
      delete process.env.EVENT_JSON
    }
  })
})

describe('profiles', () => {
  it('hides opted-out contact fields and never exposes token hashes', async () => {
    const res = await app.request('/api/people', { headers: { Cookie: member } })
    const people = await res.json()
    const jenny = people.find((p: { id: number }) => p.id === personId)
    expect(jenny.email).toBeNull()
    expect(JSON.stringify(people)).not.toContain('token')
  })

  it('lets one person claim a profile, then edit only with the token', async () => {
    const claim = await app.request(`/api/people/${personId}/claim`, { method: 'POST', headers: { Cookie: member } })
    expect(claim.status).toBe(200)
    const { token } = await claim.json()

    const second = await app.request(`/api/people/${personId}/claim`, { method: 'POST', headers: { Cookie: member } })
    expect(second.status).toBe(409)

    const noToken = await app.request('/api/me', json('PATCH', { city: 'Nowhere' }, { Cookie: member }))
    expect(noToken.status).toBe(403)
    const badToken = await app.request('/api/me', json('PATCH', { city: 'Nowhere' }, { Cookie: member, 'x-edit-token': 'wrong' }))
    expect(badToken.status).toBe(403)

    const edit = await app.request(
      '/api/me',
      json('PATCH', { city: 'Seattle', instagram: '@jenny.c', showEmail: true, edit_token_hash: 'x' }, { Cookie: member, 'x-edit-token': token }),
    )
    expect(edit.status).toBe(200)
    const me = await edit.json()
    expect(me).toMatchObject({ city: 'Seattle', instagram: 'jenny.c', email: 'jenny@example.com', showEmail: true })

    const invalid = await app.request('/api/me', json('PATCH', { email: 'not-an-email' }, { Cookie: member, 'x-edit-token': token }))
    expect(invalid.status).toBe(400)
  })

  it('turns Facebook usernames and bare websites into links, and hides them when opted out', async () => {
    const parse = (body: Record<string, string>) => parsePersonInput(body, { admin: false })
    expect(parse({ facebook: 'jenny.carter' }).facebook).toBe('https://www.facebook.com/jenny.carter')
    expect(parse({ facebook: 'facebook.com/jenny.carter' }).facebook).toBe('https://facebook.com/jenny.carter')
    expect(parse({ facebook: 'https://www.facebook.com/profile.php?id=100001' }).facebook).toBe('https://www.facebook.com/profile.php?id=100001')
    expect(parse({ website: 'tiktok.com/@jenny' }).website).toBe('https://tiktok.com/@jenny')
    expect(parse({ website: 'javascript:alert(1)' }).website).toBe('https://javascript:alert(1)')

    const id = insertPerson(db, { name: 'Link Person', facebook: 'https://www.facebook.com/lp', website: 'https://lp.dev', show_facebook: 0 })
    const people = await (await app.request('/api/people', { headers: { Cookie: member } })).json()
    expect(people.find((p: { id: number }) => p.id === id)).toMatchObject({ facebook: null, website: 'https://lp.dev' })
  })

  it('accepts phone numbers, rejects junk, and hides the phone when opted out', async () => {
    const parse = (body: Record<string, string>) => parsePersonInput(body, { admin: false })
    expect(parse({ phone: ' +972 (50) 123-4567 ' }).phone).toBe('+972 (50) 123-4567')
    expect(parse({ phone: '' }).phone).toBeNull()
    expect(() => parse({ phone: 'call me' })).toThrow('מספר הטלפון לא תקין')
    expect(() => parse({ phone: '12345' })).toThrow('מספר הטלפון לא תקין')

    const shown = insertPerson(db, { name: 'Phone Shown', phone: '050-1234567' })
    const hidden = insertPerson(db, { name: 'Phone Hidden', phone: '050-7654321', show_phone: 0 })
    const people = await (await app.request('/api/people', { headers: { Cookie: member } })).json()
    expect(people.find((p: { id: number }) => p.id === shown).phone).toBe('050-1234567')
    expect(people.find((p: { id: number }) => p.id === hidden).phone).toBeNull()
  })

  it('turns any X or Twitter link into a bare handle, and hides it when opted out', async () => {
    const parse = (body: Record<string, string>) => parsePersonInput(body, { admin: false })
    for (const input of ['@jenny_c', 'jenny_c', 'https://x.com/jenny_c', 'twitter.com/jenny_c/', 'https://mobile.twitter.com/jenny_c?lang=he']) {
      expect(parse({ x: input }).x, input).toBe('jenny_c')
    }
    expect(() => parse({ x: 'not a handle' })).toThrow('שם המשתמש ב-X לא תקין')

    const id = insertPerson(db, { name: 'X Hidden', x: 'hidden_one', show_x: 0 })
    const people = await (await app.request('/api/people', { headers: { Cookie: member } })).json()
    expect(people.find((p: { id: number }) => p.id === id).x).toBeNull()
  })

  it('processes photo uploads to WebP and serves them behind the gate', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'New Kid' }, { Cookie: member }))
    expect(created.status).toBe(201)
    const { token } = await created.json()
    const upload = await app.request('/api/me/photo/now', {
      method: 'POST',
      headers: { Cookie: member, 'x-edit-token': token },
      body: await pngUpload('photo'),
    })
    expect(upload.status).toBe(200)
    const { nowPhoto } = await upload.json()
    expect(nowPhoto).toMatch(/^\/media\/uploads\/[a-f0-9]+\.webp$/)
    expect((await app.request(nowPhoto)).status).toBe(401)
    const served = await app.request(nowPhoto, { headers: { Cookie: member } })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/webp')

    const removed = await app.request('/api/me', { method: 'DELETE', headers: { Cookie: member, 'x-edit-token': token } })
    expect(removed.status).toBe(200)
    expect((await app.request(nowPhoto, { headers: { Cookie: member } })).status).toBe(404)
  })

  it('keeps up to three photos of each kind, and makes the next one primary when the first goes', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'Shutterbug' }, { Cookie: member }))
    const { token } = await created.json()
    const headers = { Cookie: member, 'x-edit-token': token }
    const add = async (kind: 'then' | 'now') => app.request(`/api/me/photo/${kind}`, { method: 'POST', headers, body: await pngUpload('photo') })

    let person
    for (let i = 0; i < MAX_PHOTOS_PER_KIND; i++) {
      const res = await add('now')
      expect(res.status).toBe(200)
      person = await res.json()
    }
    expect(person.nowPhotos).toHaveLength(MAX_PHOTOS_PER_KIND)
    // The first upload stays the primary, the one the wall and the tiles use.
    expect(person.nowPhoto).toBe(person.nowPhotos[0].url)

    const tooMany = await add('now')
    expect(tooMany.status).toBe(400)
    expect((await tooMany.json()).error).toContain(String(MAX_PHOTOS_PER_KIND))

    // "Then" photos are counted separately, so six in total.
    const then = await add('then')
    expect(then.status).toBe(200)
    expect((await then.json()).thenPhotos).toHaveLength(1)

    const [first, second] = person.nowPhotos
    const dropped = await app.request(`/api/me/photo/${first.id}`, { method: 'DELETE', headers })
    expect(dropped.status).toBe(200)
    const after = await dropped.json()
    expect(after.nowPhotos).toHaveLength(MAX_PHOTOS_PER_KIND - 1)
    expect(after.nowPhoto).toBe(second.url)
    expect((await app.request(first.url, { headers: { Cookie: member } })).status).toBe(404)

    // The profile page reads its photos from here, not from the upload response.
    const mine = await (await app.request('/api/me', { headers })).json()
    expect(mine.nowPhotos).toHaveLength(MAX_PHOTOS_PER_KIND - 1)
    expect(mine.nowPhoto).toBe(second.url)
    expect(mine.thenPhotos).toHaveLength(1)
  })

  it('will not let one owner delete a photo that belongs to someone else', async () => {
    const mine = await (await app.request('/api/people', json('POST', { name: 'Photo Owner' }, { Cookie: member }))).json()
    const theirs = await (await app.request('/api/people', json('POST', { name: 'Someone Else' }, { Cookie: member }))).json()
    const uploaded = await app.request('/api/me/photo/now', {
      method: 'POST',
      headers: { Cookie: member, 'x-edit-token': theirs.token },
      body: await pngUpload('photo'),
    })
    const [photo] = (await uploaded.json()).nowPhotos

    const attempt = await app.request(`/api/me/photo/${photo.id}`, { method: 'DELETE', headers: { Cookie: member, 'x-edit-token': mine.token } })
    expect(attempt.status).toBe(404)
    expect((await app.request(photo.url, { headers: { Cookie: member } })).status).toBe(200)
  })
})

describe('admin', () => {
  it('is closed to regular members', async () => {
    expect((await app.request('/api/admin/people', json('POST', { name: 'X' }, { Cookie: member }))).status).toBe(403)
    expect((await app.request('/api/admin/rebuild-wall', { method: 'POST', headers: { Cookie: member } })).status).toBe(403)
  })

  it('imports a CSV roster and reports bad rows', async () => {
    const csv = 'Name,Email,City\n"Okafor, Sam",sam@example.com,"Austin, TX"\n,missing@example.com,\nPat Kim,bad-email,\n'
    const res = await app.request('/api/admin/import-csv', { method: 'POST', headers: { Cookie: admin }, body: csv })
    expect(await res.json()).toMatchObject({ added: 1, skipped: [expect.stringContaining('שורה 3'), expect.stringContaining('שורה 4')] })
  })

  it('builds the wall with one tag per person, tiles a group photo, and supports tagging', async () => {
    const wall = await app.request('/api/admin/rebuild-wall', { method: 'POST', headers: { Cookie: admin } })
    const [scene] = await wall.json()
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }
    expect(scene.kind).toBe('mosaic')
    expect(scene.tags).toHaveLength(n)
    expect((await app.request(scene.dzi, { headers: { Cookie: member } })).status).toBe(200)

    const upload = await app.request('/api/admin/scenes', { method: 'POST', headers: { Cookie: admin }, body: await pngUpload('image', { title: 'Prom' }) })
    expect(upload.status).toBe(201)
    const group = await upload.json()
    expect(group).toMatchObject({ kind: 'group', width: 600, height: 400, title: 'Prom' })

    const tag = await app.request(`/api/admin/scenes/${group.id}/tags`, json('POST', { x: 10, y: 10, w: 50, h: 60 }, { Cookie: admin }))
    expect(tag.status).toBe(201)
    const { id: tagId } = await tag.json()

    // An unidentified face can be claimed once, and only by someone holding a profile token.
    const anonymous = await app.request(`/api/tags/${tagId}/identify`, { method: 'POST', headers: { Cookie: member } })
    expect(anonymous.status).toBe(403)
    const { token } = await (await app.request('/api/people', json('POST', { name: 'Face Owner' }, { Cookie: member }))).json()
    const mine = await app.request(`/api/tags/${tagId}/identify`, { method: 'POST', headers: { Cookie: member, 'x-edit-token': token } })
    expect(mine.status).toBe(200)
    const again = await app.request(`/api/tags/${tagId}/identify`, { method: 'POST', headers: { Cookie: member, 'x-edit-token': token } })
    expect(again.status).toBe(409)
  })

  it('lets the owner take their name off a face, and nobody else', async () => {
    const scenes = await (await app.request('/api/scenes', { headers: { Cookie: member } })).json()
    const group = scenes.find((s: { kind: string }) => s.kind === 'group')
    const { id: tagId } = await (await app.request(`/api/admin/scenes/${group.id}/tags`, json('POST', { x: 200, y: 200, w: 50, h: 60 }, { Cookie: admin }))).json()
    const { token } = await (await app.request('/api/people', json('POST', { name: 'Wrong Face' }, { Cookie: member }))).json()
    const { token: other } = await (await app.request('/api/people', json('POST', { name: 'Someone Else' }, { Cookie: member }))).json()
    await app.request(`/api/tags/${tagId}/identify`, { method: 'POST', headers: { Cookie: member, 'x-edit-token': token } })
    const untag = (headers: Record<string, string>) => app.request(`/api/tags/${tagId}/identify`, { method: 'DELETE', headers: { Cookie: member, ...headers } })

    expect((await untag({})).status).toBe(403)
    expect((await untag({ 'x-edit-token': other })).status).toBe(404)
    const mine = await untag({ 'x-edit-token': token })
    expect(mine.status).toBe(200)
    expect(await mine.json()).toMatchObject({ id: tagId, personId: null })
    expect((await untag({ 'x-edit-token': token })).status).toBe(404)

    // Back to unnamed, so the right person can be named on it.
    const renamed = await app.request(`/api/tags/${tagId}/suggest`, json('POST', { name: 'Right Face' }, { Cookie: member }))
    expect(renamed.status).toBe(200)
  })

  it('does not let an owner remove themselves from the generated wall', async () => {
    const wall = (await (await app.request('/api/scenes', { headers: { Cookie: member } })).json()).find((s: { kind: string }) => s.kind === 'mosaic')
    const { token } = await (await app.request('/api/people', json('POST', { name: 'On The Wall' }, { Cookie: member }))).json()
    const me = await (await app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': token } })).json()
    const { lastInsertRowid } = db.prepare('INSERT INTO tags (scene_id, person_id, x, y, w, h) VALUES (?, ?, 0, 0, 10, 10)').run(wall.id, me.id)
    const res = await app.request(`/api/tags/${lastInsertRowid}/identify`, { method: 'DELETE', headers: { Cookie: member, 'x-edit-token': token } })
    expect(res.status).toBe(404)
  })

  it('lets classmates name an unidentified face once, and serves a gated face crop', async () => {
    const scenes = await (await app.request('/api/scenes', { headers: { Cookie: member } })).json()
    const group = scenes.find((s: { kind: string }) => s.kind === 'group')
    const tag = await app.request(`/api/admin/scenes/${group.id}/tags`, json('POST', { x: 100, y: 100, w: 80, h: 100 }, { Cookie: admin }))
    const { id: tagId } = await tag.json()

    const blank = await app.request(`/api/tags/${tagId}/suggest`, json('POST', { name: '  ' }, { Cookie: member }))
    expect(blank.status).toBe(400)
    const named = await app.request(`/api/tags/${tagId}/suggest`, json('POST', { name: 'דנה לוי' }, { Cookie: member }))
    expect(named.status).toBe(200)
    const { personId: namedId } = await named.json()
    const people = await (await app.request('/api/people', { headers: { Cookie: member } })).json()
    expect(people.find((p: { id: number }) => p.id === namedId)).toMatchObject({ name: 'דנה לוי', claimed: false })
    const again = await app.request(`/api/tags/${tagId}/suggest`, json('POST', { name: 'Someone Else' }, { Cookie: member }))
    expect(again.status).toBe(409)

    expect((await app.request(`/api/tags/${tagId}/face`)).status).toBe(401)
    const face = await app.request(`/api/tags/${tagId}/face`, { headers: { Cookie: member } })
    expect(face.status).toBe(200)
    expect(face.headers.get('content-type')).toBe('image/webp')
  })

  it('bulk-adds detected faces as unidentified tags and can clear them again', async () => {
    const scenes = await (await app.request('/api/scenes', { headers: { Cookie: member } })).json()
    const group = scenes.find((s: { kind: string }) => s.kind === 'group')
    const bad = await app.request(`/api/admin/scenes/${group.id}/tags/batch`, json('POST', { boxes: [{ x: 1, y: 1, w: 0, h: 5 }] }, { Cookie: admin }))
    expect(bad.status).toBe(400)
    const boxes = [{ x: 200, y: 50, w: 40, h: 50 }, { x: 300, y: 50, w: 40, h: 50 }]
    const added = await app.request(`/api/admin/scenes/${group.id}/tags/batch`, json('POST', { boxes }, { Cookie: admin }))
    expect(await added.json()).toEqual({ added: 2 })
    const asMember = await app.request(`/api/admin/scenes/${group.id}/tags/batch`, json('POST', { boxes }, { Cookie: member }))
    expect(asMember.status).toBe(403)
    const cleared = await app.request(`/api/admin/scenes/${group.id}/unidentified-tags`, { method: 'DELETE', headers: { Cookie: admin } })
    expect(await cleared.json()).toEqual({ removed: 2 })
  })

  it('resets a claim so the profile can be claimed again', async () => {
    await app.request(`/api/admin/people/${personId}/reset-claim`, { method: 'POST', headers: { Cookie: admin } })
    const claim = await app.request(`/api/people/${personId}/claim`, { method: 'POST', headers: { Cookie: member } })
    expect(claim.status).toBe(200)
  })
})

describe('mixtape shelf', () => {
  it('understands pasted YouTube, YouTube Music and Spotify links', () => {
    const yt = (kind: string, externalId: string) => ({ provider: 'youtube', kind, externalId })
    const sp = (kind: string, externalId: string) => ({ provider: 'spotify', kind, externalId })
    const list = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'
    const track = '4cOdK2wGLETKBW3PvgPWqT'
    const cases: [string, unknown][] = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', yt('video', 'dQw4w9WgXcQ')],
      ['https://youtu.be/dQw4w9WgXcQ?si=abc', yt('video', 'dQw4w9WgXcQ')],
      ['youtube.com/shorts/dQw4w9WgXcQ', yt('video', 'dQw4w9WgXcQ')],
      ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x', yt('video', 'dQw4w9WgXcQ')],
      [`https://www.youtube.com/playlist?list=${list}`, yt('playlist', list)],
      [`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${list}&index=3`, yt('playlist', list)],
      ['https://music.youtube.com/playlist?list=OLAK5uy_kS3FYJm0Ov6ePMCGXCTS4BqXd1nHm8H6Y', yt('playlist', 'OLAK5uy_kS3FYJm0Ov6ePMCGXCTS4BqXd1nHm8H6Y')],
      ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ', yt('video', 'dQw4w9WgXcQ')],
      [` ${list} `, yt('playlist', list)],
      [`https://open.spotify.com/track/${track}?si=123`, sp('track', track)],
      [`https://open.spotify.com/intl-he/album/${track}`, sp('album', track)],
      [`https://open.spotify.com/playlist/${track}`, sp('playlist', track)],
      [`spotify:artist:${track}`, sp('artist', track)],
      ['https://www.youtube.com/@RickAstleyYT', null],
      ['https://example.com/watch?v=dQw4w9WgXcQ', null],
      [`https://open.spotify.com/user/${track}`, null],
      ['hello there friends', null],
      ['', null],
    ]
    for (const [input, expected] of cases) expect(parseTapeLink(input), input).toEqual(expected)
  })

  it('names a tape from YouTube or Spotify when the classmate leaves the name blank', async () => {
    const tape = await addTape(db, { url: 'https://youtu.be/aaaaaaaaaaa' }, async () => 'Looked-up title')
    expect(tape.title).toBe('Looked-up title')
    const unnamed = await addTape(db, { url: 'https://youtu.be/bbbbbbbbbbb' }, async () => null)
    expect(unnamed.title).toBe('קלטת בלי שם')
  })

  it('lets any classmate add a tape, rejects bad or duplicate links, and only organizers remove tapes', async () => {
    expect((await app.request('/api/tapes')).status).toBe(401)
    const body = { url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', title: 'Class of 96', addedBy: 'Jenny' }
    const added = await app.request('/api/tapes', json('POST', body, { Cookie: member }))
    expect(added.status).toBe(201)
    const tape = await added.json()
    expect(tape).toMatchObject({ provider: 'spotify', kind: 'playlist', externalId: '37i9dQZF1DXcBWIGoYBM5M', title: 'Class of 96', addedBy: 'Jenny' })

    const again = await app.request('/api/tapes', json('POST', body, { Cookie: member }))
    expect(again.status).toBe(400)
    const bad = await app.request('/api/tapes', json('POST', { url: 'https://example.com/song', title: 'x' }, { Cookie: member }))
    expect(bad.status).toBe(400)
    const short = await app.request('/api/tapes', json('POST', { url: 'https://spotify.link/abc', title: 'x' }, { Cookie: member }))
    expect((await short.json()).error).toContain('open.spotify.com')

    const shelf = await (await app.request('/api/tapes', { headers: { Cookie: member } })).json()
    expect(shelf.map((t: { id: number }) => t.id)).toContain(tape.id)

    expect((await app.request(`/api/admin/tapes/${tape.id}`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)
    expect((await app.request(`/api/admin/tapes/${tape.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(200)
    expect((await app.request(`/api/admin/tapes/${tape.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(404)
  })
})

describe('video library', () => {
  it('understands pasted YouTube, Instagram, Facebook and X video links', () => {
    const v = (provider: string, externalId: string) => ({ provider, externalId })
    const cases: [string, unknown][] = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', v('youtube', 'dQw4w9WgXcQ')],
      ['https://youtu.be/dQw4w9WgXcQ?si=abc', v('youtube', 'dQw4w9WgXcQ')],
      ['youtube.com/shorts/dQw4w9WgXcQ', v('youtube', 'dQw4w9WgXcQ')],
      ['https://www.instagram.com/p/C1a2B3c4D5e/?igsh=xyz', v('instagram', 'C1a2B3c4D5e')],
      ['https://www.instagram.com/reel/C1a2B3c4D5e/', v('instagram', 'C1a2B3c4D5e')],
      ['instagram.com/reels/C1a2B3c4D5e', v('instagram', 'C1a2B3c4D5e')],
      ['https://www.instagram.com/jenny.c/p/C1a2B3c4D5e/', v('instagram', 'C1a2B3c4D5e')],
      ['https://www.facebook.com/watch/?v=1234567890123', v('facebook', '1234567890123')],
      ['https://m.facebook.com/watch?v=1234567890123&ref=sharing', v('facebook', '1234567890123')],
      ['https://www.facebook.com/SomePage/videos/1234567890123/', v('facebook', '1234567890123')],
      ['https://www.facebook.com/SomePage/videos/graduation-night/1234567890123/', v('facebook', '1234567890123')],
      ['https://www.facebook.com/reel/1234567890123', v('facebook', '1234567890123')],
      ['https://x.com/someone/status/1790000000000000000', v('x', '1790000000000000000')],
      ['https://twitter.com/someone/status/1790000000000000000/video/1', v('x', '1790000000000000000')],
      ['mobile.twitter.com/i/status/1790000000000000000?s=20', v('x', '1790000000000000000')],
      ['https://www.youtube.com/@RickAstleyYT', null],
      ['https://www.instagram.com/jenny.c/', null],
      ['https://www.facebook.com/jenny.carter', null],
      ['https://x.com/someone', null],
      ['https://example.com/watch?v=dQw4w9WgXcQ', null],
      ['hello there friends', null],
      ['', null],
    ]
    for (const [input, expected] of cases) expect(parseVideoLink(input), input).toEqual(expected)
  })

  it('names a video from the lookup, or by where it came from when there is no title', async () => {
    const named = await addVideo(db, { url: 'https://youtu.be/ccccccccccc' }, async () => 'Graduation night')
    expect(named.title).toBe('Graduation night')
    const insta = await addVideo(db, { url: 'https://www.instagram.com/reel/Cabcdefghij/' }, async () => null)
    expect(insta).toMatchObject({ title: 'סרטון מאינסטגרם', url: 'https://www.instagram.com/p/Cabcdefghij/' })
  })

  it('turns album videos into tapes that point back to the album and cannot be removed', () => {
    const album = 'https://photos.google.com/share/abc?key=def'
    const entries = albumVideoEntries([{ src: 'https://lh3.googleusercontent.com/pw/vid-1', width: 480, height: 360, durationMs: 7328577 }], album)
    expect(entries).toEqual([
      { id: -1000, provider: 'gphotos', externalId: 'vid-1', title: 'סרטון מהאלבום המשותף', note: 'אורך: 2:02:09', addedBy: null, url: album },
    ])
    expect([formatDuration(65_000), formatDuration(3_600_000)]).toEqual(['1:05', '1:00:00'])
    const named = albumVideoEntries([{ src: 'https://lh3.googleusercontent.com/pw/vid-1', width: 480, height: 360, durationMs: 1000, itemId: 'AF1Qipabc' }], album, {
      AF1Qipabc: 'End of year play',
    })
    expect(named[0].title).toBe('End of year play')
  })

  it("lists the organizers' videos first, and skips ones it cannot play", () => {
    const featured = [
      { title: 'Opening', url: 'https://youtu.be/ddddddddddd', note: 'From the organizers' },
      { title: 'Broken', url: 'https://example.com/video' },
      { title: 'Speech', url: 'https://x.com/a/status/1790000000000000001' },
    ]
    const list = listVideos(db, featured)
    expect(list.slice(0, 2)).toMatchObject([
      { id: 0, provider: 'youtube', externalId: 'ddddddddddd', title: 'Opening', note: 'From the organizers' },
      { id: -1, provider: 'x', externalId: '1790000000000000001', title: 'Speech' },
    ])
    expect(list.slice(2).every((v) => v.id > 0)).toBe(true)
  })

  it('lets any classmate add a video, rejects bad or duplicate links, and only organizers remove videos', async () => {
    expect((await app.request('/api/videos')).status).toBe(401)
    const body = { url: 'https://www.facebook.com/SomePage/videos/9876543210123/', title: 'Prom 96', note: 'Tape from my dad', addedBy: 'Jenny' }
    const added = await app.request('/api/videos', json('POST', body, { Cookie: member }))
    expect(added.status).toBe(201)
    const video = await added.json()
    expect(video).toMatchObject({ provider: 'facebook', externalId: '9876543210123', title: 'Prom 96', note: 'Tape from my dad', addedBy: 'Jenny' })
    expect(video.url).toBe('https://www.facebook.com/watch/?v=9876543210123')

    expect((await app.request('/api/videos', json('POST', body, { Cookie: member }))).status).toBe(400)
    const bad = await app.request('/api/videos', json('POST', { url: 'https://example.com/clip' }, { Cookie: member }))
    expect(bad.status).toBe(400)
    const share = await app.request('/api/videos', json('POST', { url: 'https://www.facebook.com/share/v/1AbCdEf/' }, { Cookie: member }))
    expect((await share.json()).error).toContain('הכתובת המלאה')

    const list = await (await app.request('/api/videos', { headers: { Cookie: member } })).json()
    expect(list.map((v: { id: number }) => v.id)).toContain(video.id)

    expect((await app.request(`/api/admin/videos/${video.id}`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)
    expect((await app.request(`/api/admin/videos/${video.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(200)
    expect((await app.request(`/api/admin/videos/${video.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(404)
  })
})

describe('quote reactions', () => {
  const as = (reactor: string) => ({ Cookie: member, 'x-reactor': reactor })
  const ANNA = 'anna-browser-key-0001'
  const BEN = 'ben-browser-key-00002'

  it('counts one reaction per person: a new pick replaces the old one, and picking nothing takes it back', async () => {
    const quote = await (await app.request('/api/quotes', json('POST', { text: 'Quiet in the back!' }, { Cookie: member }))).json()
    expect(quote).toMatchObject({ reactions: [], myReaction: null })
    const react = (reactor: string, emoji: string) => app.request(`/api/quotes/${quote.id}/reaction`, json('PUT', { emoji }, as(reactor)))

    expect(await (await react(ANNA, '😂')).json()).toEqual({ reactions: [{ emoji: '😂', count: 1 }], myReaction: '😂' })
    await react(BEN, '😂')
    await react(BEN, '❤️')
    expect(await (await react(ANNA, '😂')).json()).toEqual({ reactions: [{ emoji: '😂', count: 1 }, { emoji: '❤️', count: 1 }], myReaction: '😂' })

    // Everyone sees the counters; only Ben sees Ben's pick.
    const seenBy = async (reactor: string) => (await (await app.request('/api/quotes', { headers: as(reactor) })).json()).find((q: { id: number }) => q.id === quote.id)
    expect(await seenBy(BEN)).toMatchObject({ reactions: [{ emoji: '😂', count: 1 }, { emoji: '❤️', count: 1 }], myReaction: '❤️' })
    expect((await seenBy('someone-else-key-0003')).myReaction).toBeNull()

    expect(await (await react(ANNA, '')).json()).toEqual({ reactions: [{ emoji: '❤️', count: 1 }], myReaction: null })
  })

  it('rejects an emoji that is not on offer, a missing browser key, a missing quote, and visitors without the passcode', async () => {
    const quote = await (await app.request('/api/quotes', json('POST', { text: 'Books closed' }, { Cookie: member }))).json()
    expect((await app.request(`/api/quotes/${quote.id}/reaction`, json('PUT', { emoji: '💩' }, as(ANNA)))).status).toBe(400)
    expect((await app.request(`/api/quotes/${quote.id}/reaction`, json('PUT', { emoji: '👍' }, { Cookie: member }))).status).toBe(400)
    expect((await app.request('/api/quotes/99999/reaction', json('PUT', { emoji: '👍' }, as(ANNA)))).status).toBe(400)
    expect((await app.request(`/api/quotes/${quote.id}/reaction`, json('PUT', { emoji: '👍' }, { 'x-reactor': ANNA }))).status).toBe(401)
  })

  it('removing a quote removes its reactions', async () => {
    const quote = await (await app.request('/api/quotes', json('POST', { text: 'Last warning' }, { Cookie: member }))).json()
    await app.request(`/api/quotes/${quote.id}/reaction`, json('PUT', { emoji: '🙏' }, as(ANNA)))
    await app.request(`/api/admin/quotes/${quote.id}`, { method: 'DELETE', headers: { Cookie: admin } })
    expect((db.prepare('SELECT COUNT(*) AS n FROM quote_reactions WHERE quote_id = ?').get(quote.id) as { n: number }).n).toBe(0)
  })
})

describe('quotes wall', () => {
  it('lets any classmate add a quote and comment on it, rejects empty ones, and only organizers remove them', async () => {
    expect((await app.request('/api/quotes')).status).toBe(401)
    const added = await app.request(
      '/api/quotes',
      json('POST', { text: '  Take out a sheet of paper  ', saidBy: 'Mrs. Levin', context: 'Every Monday', addedBy: 'Jenny' }, { Cookie: member }),
    )
    expect(added.status).toBe(201)
    const quote = await added.json()
    expect(quote).toMatchObject({ text: 'Take out a sheet of paper', saidBy: 'Mrs. Levin', context: 'Every Monday', addedBy: 'Jenny', comments: [] })

    expect((await app.request('/api/quotes', json('POST', { text: '   ' }, { Cookie: member }))).status).toBe(400)
    expect((await app.request('/api/quotes', json('POST', { text: 'x'.repeat(501) }, { Cookie: member }))).status).toBe(400)

    const commented = await app.request(`/api/quotes/${quote.id}/comments`, json('POST', { message: 'Also on Thursdays', addedBy: 'Guy' }, { Cookie: member }))
    expect(commented.status).toBe(201)
    const comment = await commented.json()
    expect((await app.request(`/api/quotes/${quote.id}/comments`, json('POST', { message: '' }, { Cookie: member }))).status).toBe(400)
    expect((await app.request('/api/quotes/99999/comments', json('POST', { message: 'hi' }, { Cookie: member }))).status).toBe(400)

    const list = await (await app.request('/api/quotes', { headers: { Cookie: member } })).json()
    expect(list.find((q: { id: number }) => q.id === quote.id).comments).toMatchObject([{ message: 'Also on Thursdays', addedBy: 'Guy' }])

    expect((await app.request(`/api/admin/quote-comments/${comment.id}`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)
    expect((await app.request(`/api/admin/quote-comments/${comment.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(200)
    expect((await app.request(`/api/admin/quotes/${quote.id}`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)

    // Removing a quote takes its comments with it.
    await app.request(`/api/quotes/${quote.id}/comments`, json('POST', { message: 'Still here?' }, { Cookie: member }))
    expect((await app.request(`/api/admin/quotes/${quote.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(200)
    expect((await app.request(`/api/admin/quotes/${quote.id}`, { method: 'DELETE', headers: { Cookie: admin } })).status).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS n FROM quote_comments WHERE quote_id = ?').get(quote.id)).toEqual({ n: 0 })
  })
})

describe('feedback', () => {
  it('saves feedback from any classmate and lists it only for admins', async () => {
    const sent = await app.request('/api/feedback', json('POST', { message: '  The mixtape skips  ', sender: 'Jenny' }, { Cookie: member }))
    expect(sent.status).toBe(201)
    expect(await sent.json()).toMatchObject({ message: 'The mixtape skips', sender: 'Jenny', emailed: false })

    expect((await app.request('/api/feedback', json('POST', { message: '   ' }, { Cookie: member }))).status).toBe(400)
    expect((await app.request('/api/feedback', json('POST', { message: 'hi' }, {}))).status).toBe(401)

    expect((await app.request('/api/admin/feedback', { headers: { Cookie: member } })).status).toBe(403)
    const list = await (await app.request('/api/admin/feedback', { headers: { Cookie: admin } })).json()
    expect(list[0]).toMatchObject({ message: 'The mixtape skips', sender: 'Jenny' })
  })

  it('emails feedback with a reply-to address, and keeps it when the email fails', async () => {
    const outbox: Parameters<SendEmail>[0][] = []
    const ok = await addFeedback(db, { message: 'Love it', sender: 'Guy <guy@example.com>' }, async (m) => void outbox.push(m))
    expect(ok.emailed).toBe(true)
    expect(outbox[0]).toMatchObject({ text: expect.stringContaining('Love it'), replyTo: 'guy@example.com' })

    const failed = await addFeedback(db, { message: 'Still saved' }, async () => {
      throw new Error('down')
    })
    expect(failed).toMatchObject({ message: 'Still saved', sender: null, emailed: false })
  })

  it('sends through Resend only when a key and recipient are configured', async () => {
    expect(feedbackSender(config)).toBeNull()
    const calls: [string, RequestInit][] = []
    const fakeFetch = (async (url: string, init: RequestInit) => (calls.push([url, init]), new Response('{}'))) as unknown as typeof fetch
    const send = feedbackSender({ ...config, resendApiKey: 'key', feedbackTo: 'me@example.com', emailFrom: 'Site <a@b.dev>' }, fakeFetch)!
    await send({ subject: 'Hi', text: 'Body' })
    expect(calls[0][0]).toBe('https://api.resend.com/emails')
    expect(calls[0][1].headers).toMatchObject({ Authorization: 'Bearer key' })
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ from: 'Site <a@b.dev>', to: ['me@example.com'], subject: 'Hi', text: 'Body' })
  })
})

describe('Gmail relay', () => {
  it('posts the message with the shared secret, counts it sent only when the script says so, and gives way to Resend', async () => {
    const relay = { ...config, gmailRelayUrl: 'https://script.google.test/exec', gmailRelaySecret: 'shh' }
    const calls: [string, RequestInit][] = []
    let answer: unknown = { ok: true }
    const fakeFetch = (async (url: string, init: RequestInit) => (calls.push([url, init]), Response.json(answer))) as unknown as typeof fetch
    const message = { to: 'pal@example.com', subject: 'Hi', text: 'Body' }

    expect(configuredMailer(config)).toBeNull()
    const mail = configuredMailer(relay, fakeFetch)!
    await mail(message)
    expect(calls[0][0]).toBe('https://script.google.test/exec')
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ secret: 'shh', ...message })

    // Apps Script answers 200 even when sending failed, so the body decides.
    answer = { ok: false, error: 'forbidden' }
    await expect(mail(message)).rejects.toThrow('forbidden')

    await configuredMailer({ ...relay, resendApiKey: 'key' }, fakeFetch)!(message)
    expect(calls[2][0]).toBe('https://api.resend.com/emails')
  })

  it('follows Google redirects by hand, keeping the message, and never fails once the script has run', async () => {
    const exec = 'https://script.google.com/macros/s/ID/exec'
    const moved = 'https://script.google.com/macros/u/1/s/ID/exec'
    const answer = 'https://script.googleusercontent.com/macros/echo?user_content_key=1'
    const calls: { url: string; method: string; body?: string }[] = []
    let routes: Record<string, () => Response> = {}
    const fakeFetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined })
      return routes[url]()
    }) as unknown as typeof fetch
    const to = (url: string) => () => Response.redirect(url, 302)
    const mail = gmailRelayMailer({ ...config, gmailRelayUrl: exec, gmailRelaySecret: 'shh' }, fakeFetch)!
    const message = { to: 'pal@example.com', subject: 'Hi', text: 'Body' }

    // Usually the script runs on the POST, and its answer waits at a one-time address.
    routes = { [exec]: to(answer), [answer]: () => Response.json({ ok: true }) }
    await mail(message)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])

    // Sometimes Google moves the POST first: it goes out again there, message and all.
    calls.length = 0
    routes = { [exec]: to(moved), [moved]: to(answer), [answer]: () => Response.json({ ok: true }) }
    await mail(message)
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', exec], ['POST', moved], ['GET', answer]])
    expect(JSON.parse(calls[1].body!)).toEqual({ secret: 'shh', ...message })

    // The script ran but its answer is gone: counted as sent, so a note alert does not go out twice.
    routes = { [exec]: to(answer), [answer]: () => new Response('<html>Page Not Found</html>', { status: 404 }) }
    await expect(mail(message)).resolves.toBeUndefined()

    // The script refusing, or an error page instead of the script, is a failure.
    routes = { [exec]: to(answer), [answer]: () => Response.json({ ok: false, error: 'forbidden' }) }
    await expect(mail(message)).rejects.toThrow('forbidden')
    routes = { [exec]: () => new Response('<html>Script function not found: doGet</html>') }
    await expect(mail(message)).rejects.toThrow('Gmail relay answered 200')
  })
})

describe('notes', () => {
  it('delivers signed and anonymous notes privately, and only the recipient can read or throw them away', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'Note Sender' }, { Cookie: member }))
    const { token: senderToken, person: sender } = await created.json()
    const recipientRes = await app.request('/api/people', json('POST', { name: 'Note Recipient' }, { Cookie: member }))
    const { token: recipientToken, person: recipient } = await recipientRes.json()
    const asSender = { Cookie: member, 'x-edit-token': senderToken }
    const asRecipient = { Cookie: member, 'x-edit-token': recipientToken }

    expect((await app.request('/api/notes', json('POST', { to: recipient.id, message: 'Signed hello' }, asSender))).status).toBe(201)
    expect((await app.request('/api/notes', json('POST', { to: recipient.id, message: 'Guess who', anonymous: true }, { Cookie: member }))).status).toBe(201)
    // Signing needs a profile; writing to yourself or with nothing to say is refused.
    expect((await app.request('/api/notes', json('POST', { to: recipient.id, message: 'Hi' }, { Cookie: member }))).status).toBe(400)
    expect((await app.request('/api/notes', json('POST', { to: sender.id, message: 'Me' }, asSender))).status).toBe(400)
    expect((await app.request('/api/notes', json('POST', { to: recipient.id, message: '  ' }, asSender))).status).toBe(400)

    expect((await (await app.request('/api/me', { headers: asRecipient })).json()).unreadNotes).toBe(2)
    const notes = await (await app.request('/api/me/notes', { headers: asRecipient })).json()
    expect(notes).toMatchObject([
      { message: 'Guess who', from: null, read: false },
      { message: 'Signed hello', from: { id: sender.id, name: 'Note Sender' }, read: false },
    ])
    expect(JSON.stringify(await (await app.request('/api/me/notes', { headers: asSender })).json())).not.toContain('hello')

    const [anon, signed] = notes
    // The anonymous note keeps no trace of who sent it.
    expect({ ...db.prepare('SELECT sender_id, sender_name FROM notes WHERE id = ?').get(anon.id) }).toEqual({ sender_id: null, sender_name: null })
    expect((await app.request(`/api/me/notes/${signed.id}/read`, { method: 'POST', headers: asSender })).status).toBe(404)
    expect((await app.request(`/api/me/notes/${signed.id}`, { method: 'DELETE', headers: asSender })).status).toBe(404)
    expect((await app.request(`/api/me/notes/${signed.id}/read`, { method: 'POST', headers: asRecipient })).status).toBe(200)
    expect((await app.request(`/api/me/notes/${anon.id}`, { method: 'DELETE', headers: asRecipient })).status).toBe(200)
    expect(await (await app.request('/api/me/notes', { headers: asRecipient })).json()).toMatchObject([{ id: signed.id, read: true }])
  })

  it('emails the recipient that a note is waiting, without who wrote it or what it says, at most once per cooldown', async () => {
    const outbox: Parameters<Mailer>[0][] = []
    let emailDown = false
    const mailApp = createApp({ ...config, publicUrl: 'https://reunion.test' }, db, async (m) => {
      if (emailDown) throw new Error('down')
      outbox.push(m)
    })
    const created = await mailApp.request('/api/people', json('POST', { name: 'Letter Writer' }, { Cookie: member }))
    const asWriter = { Cookie: member, 'x-edit-token': (await created.json()).token }
    const penPal = insertPerson(db, { name: 'Pen Pal', email: 'penpal@example.com' })
    const noEmail = insertPerson(db, { name: 'Offline Friend' })
    const pass = (to: number, message: string, headers: Record<string, string> = asWriter, anonymous = false) =>
      mailApp.request('/api/notes', json('POST', { to, message, anonymous }, headers))

    expect((await pass(penPal, 'Remember the trip to the lake?')).status).toBe(201)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ to: 'penpal@example.com', text: expect.stringContaining('Pen Pal') })
    expect(outbox[0].text).toContain('https://reunion.test/me')
    expect(JSON.stringify(outbox[0])).not.toMatch(/lake|Letter Writer/)

    // More notes right after, signed or anonymous, wait out the cooldown instead of sending more email.
    await pass(penPal, 'One more thing')
    await pass(penPal, 'Guess who', { Cookie: member }, true)
    expect(outbox).toHaveLength(1)

    // No address on the profile, no email.
    expect((await pass(noEmail, 'Hello')).status).toBe(201)
    expect(outbox).toHaveLength(1)

    // After the cooldown the next note emails again. A failed email still delivers the note, and the next note retries.
    db.prepare("UPDATE note_alerts SET sent_at = datetime('now', '-1 day') WHERE person_id = ?").run(penPal)
    emailDown = true
    expect((await pass(penPal, 'Sent while email was down')).status).toBe(201)
    emailDown = false
    await pass(penPal, 'And again')
    expect(outbox.map((m) => m.to)).toEqual(['penpal@example.com', 'penpal@example.com'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE recipient_id = ?').get(penPal)).toEqual({ n: 5 })
  })
})

describe('personal code sign-in', () => {
  it('lets the owner set a code, then sign in on another device without logging out the first', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'Code Person' }, { Cookie: member }))
    const { token: desktop, person } = await created.json()
    const asDesktop = { Cookie: member, 'x-edit-token': desktop }

    expect((await app.request('/api/me/pin', json('PUT', { pin: '123456' }, { Cookie: member }))).status).toBe(403)
    expect((await app.request('/api/me/pin', json('PUT', { pin: '12' }, asDesktop))).status).toBe(400)
    const set = await app.request('/api/me/pin', json('PUT', { pin: ' 123456 ' }, asDesktop))
    expect(await set.json()).toMatchObject({ hasPin: true })

    const people = await (await app.request('/api/people', { headers: { Cookie: member } })).text()
    expect(people).not.toContain('pin_hash')
    expect(JSON.parse(people).find((p: { id: number }) => p.id === person.id)).toMatchObject({ hasPin: true })

    const login = (pin: string, ip: string) => app.request(`/api/people/${person.id}/login`, json('POST', { pin }, { Cookie: member, 'x-real-ip': ip }))
    expect((await login('654321', '10.7.0.1')).status).toBe(401)
    const ok = await login('123456', '10.7.0.2')
    expect(ok.status).toBe(200)
    const { token: phone } = await ok.json()

    expect((await (await app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': phone } })).json()).id).toBe(person.id)
    expect((await app.request('/api/me', { headers: asDesktop })).status).toBe(200)

    // An organizer reset signs out every device and clears the code.
    await app.request(`/api/admin/people/${person.id}/reset-claim`, { method: 'POST', headers: { Cookie: admin } })
    expect((await app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': phone } })).status).toBe(403)
    expect((await login('123456', '10.7.0.3')).status).toBe(400)
  })

  it('stops guessing a profile code after 10 wrong tries, even from different addresses', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'Guess Target' }, { Cookie: member }))
    const { token, person } = await created.json()
    await app.request('/api/me/pin', json('PUT', { pin: '9999' }, { Cookie: member, 'x-edit-token': token }))

    const login = (pin: string, ip: string) => app.request(`/api/people/${person.id}/login`, json('POST', { pin }, { Cookie: member, 'x-real-ip': ip }))
    for (let i = 0; i < 10; i++) expect((await login(String(1000 + i), `10.8.0.${i}`)).status).toBe(401)
    expect((await login('9999', '10.8.1.1')).status).toBe(429)
  })
})

describe('code chosen when claiming, and sign-in links by email', () => {
  it('sets the code (and email) in the same step as claiming or creating a profile', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'Fresh Owner', pin: '4321' }, { Cookie: member }))
    expect((await created.json()).person).toMatchObject({ hasPin: true })

    const id = insertPerson(db, { name: 'Roster Only' })
    expect((await app.request(`/api/people/${id}/claim`, json('POST', { pin: '12' }, { Cookie: member }))).status).toBe(400)
    expect((await app.request(`/api/people/${id}/claim`, json('POST', { pin: '5555', email: 'nope' }, { Cookie: member }))).status).toBe(400)
    const claimed = await app.request(`/api/people/${id}/claim`, json('POST', { pin: '5555', email: 'roster@example.com' }, { Cookie: member }))
    expect(claimed.status).toBe(200)
    const me = await (await app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': (await claimed.json()).token } })).json()
    expect(me).toMatchObject({ hasPin: true, email: 'roster@example.com' })
  })

  it('emails a one-time link that expires, and says so plainly when email is not set up', async () => {
    const outbox: Parameters<Mailer>[0][] = []
    const mailApp = createApp({ ...config, publicUrl: 'https://reunion.test' }, db, async (m) => void outbox.push(m))
    const id = insertPerson(db, { name: 'Forgetful', email: 'forgetful@example.com', claimed_at: 'now' })
    const noEmail = insertPerson(db, { name: 'No Email', claimed_at: 'now' })
    const request = (a: typeof app, personId: number) => a.request(`/api/people/${personId}/signin-link`, { method: 'POST', headers: { Cookie: member } })

    expect(await (await request(app, id)).json()).toMatchObject({ error: expect.stringContaining('עוד לא הוגדרה') })
    expect((await request(mailApp, noEmail)).status).toBe(400)

    const sent = await request(mailApp, id)
    expect(await sent.json()).toEqual({ sentTo: 'f***@example.com' })
    expect(outbox[0].to).toBe('forgetful@example.com')
    const link = outbox[0].text.match(/https:\/\/reunion\.test\/signin\/(\S+)/)![1]
    expect((await request(mailApp, id)).status).toBe(400) // cooldown: no second email right away

    const signin = (token: string) => mailApp.request('/api/signin', json('POST', { token }, { Cookie: member }))
    const ok = await signin(link)
    expect(ok.status).toBe(200)
    const me = await (await mailApp.request('/api/me', { headers: { Cookie: member, 'x-edit-token': (await ok.json()).token } })).json()
    expect(me.id).toBe(id)
    expect((await signin(link)).status).toBe(400) // works once

    db.prepare("UPDATE recovery_tokens SET created_at = datetime('now', '-1 hour')").run()
    await request(mailApp, id)
    const second = outbox[1].text.match(/signin\/(\S+)/)![1]
    db.prepare("UPDATE recovery_tokens SET expires_at = datetime('now', '-1 minute')").run()
    expect((await signin(second)).status).toBe(400) // expired
  })
})
