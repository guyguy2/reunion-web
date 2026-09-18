import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { insertPerson } from '../server/people.ts'

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
