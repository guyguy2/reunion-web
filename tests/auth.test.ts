import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { MAX_UPLOAD_BYTES } from '../server/images.ts'
import { insertPerson } from '../server/people.ts'
import { insertTag } from '../server/scenes.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-auth-test-'))
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
const MB = 1024 * 1024
const HEBREW = /[֐-׿]/

// Every rate-limit test gets an address of its own, so no test inherits another's failures.
let lastIp = 0
const freshIp = () => `10.20.0.${++lastIp}`

async function login(passcode: string, ip = '10.20.255.1'): Promise<string> {
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

function raw(method: string, body: string, headers: Record<string, string>) {
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body }
}

/** Random pixels do not compress, so this PNG is well over the 64 KB limit for ordinary requests. */
async function noisyPng(width = 200, height = 200): Promise<Buffer> {
  return sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer()
}

function upload(field: string, bytes: Uint8Array, extra: Record<string, string> = {}) {
  const form = new FormData()
  form.set(field, new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }))
  for (const [k, v] of Object.entries(extra)) form.set(k, v)
  return form
}

async function profileWithPin(name: string, pin: string): Promise<{ token: string; id: number }> {
  const res = await app.request('/api/people', json('POST', { name, pin }, { Cookie: member }))
  expect(res.status).toBe(201)
  const { token, person } = await res.json()
  return { token, id: person.id }
}

function addScene(title: string): number {
  const result = db
    .prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort) VALUES (?, ?, 'group', 1000, 800, ?, 1)`)
    .run(`s-${title}`, title, `scenes/s-${title}`)
  return Number(result.lastInsertRowid)
}

let member: string
let admin: string

beforeAll(async () => {
  member = await login('class-pass')
  admin = await login('admin-pass')
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('login limiter', () => {
  const attempt = (passcode: string, ip: string) => app.request('/api/login', json('POST', { passcode }, { 'x-real-ip': ip }))

  it('keeps counting wrong admin guesses across class logins in between', async () => {
    const ip = freshIp()
    for (let i = 0; i < 9; i++) expect((await attempt(`admin-guess-${i}`, ip)).status).toBe(401)
    expect((await attempt('class-pass', ip)).status).toBe(200)
    expect((await attempt('admin-guess-9', ip)).status).toBe(401)
    expect((await attempt('admin-guess-10', ip)).status).toBe(429)

    const blockedAdmin = await attempt('admin-pass', ip)
    expect(blockedAdmin.status).toBe(429)
    expect(blockedAdmin.headers.get('set-cookie')).toBeNull()

    // Guests share the venue wifi: admin guesses alone do not lock classmates out.
    expect((await attempt('class-pass', ip)).status).toBe(200)
  })

  it('answers the right admin passcode exactly like a wrong one while admin guesses are blocked', async () => {
    const ip = freshIp()
    for (let i = 0; i < 9; i++) await attempt(`admin-guess-${i}`, ip)
    expect((await attempt('class-pass', ip)).status).toBe(200)
    expect((await attempt('admin-guess-9', ip)).status).toBe(401)

    const wrong = await attempt('admin-guess-10', ip)
    const right = await attempt('admin-pass', ip)
    expect(right.status).toBe(wrong.status)
    expect(await right.json()).toEqual(await wrong.json())
    expect(right.headers.get('set-cookie')).toBeNull()

    // Both count as failed class logins too: 1 + 2 so far, 7 more reach the limit either way.
    for (let i = 0; i < 7; i++) expect((await attempt('admin-pass', ip)).status).toBe(429)
    expect((await attempt('class-pass', ip)).status).toBe(429)
  })

  it('lets a successful admin login reset both counts', async () => {
    const ip = freshIp()
    for (let i = 0; i < 9; i++) await attempt(`guess-${i}`, ip)
    expect((await attempt('admin-pass', ip)).status).toBe(200)
    for (let i = 0; i < 10; i++) expect((await attempt(`guess-${i}`, ip)).status).toBe(401)
    expect((await attempt('guess', ip)).status).toBe(429)
  })

  it('does not let a PIN sign-in clear the passcode guesses', async () => {
    const ip = freshIp()
    const { id } = await profileWithPin('Pin Clearer', '2468')
    for (let i = 0; i < 9; i++) expect((await attempt(`guess-${i}`, ip)).status).toBe(401)
    const pin = await app.request(`/api/people/${id}/login`, json('POST', { pin: '2468' }, { Cookie: member, 'x-real-ip': ip }))
    expect(pin.status).toBe(200)
    expect((await attempt('guess-9', ip)).status).toBe(401)
    expect((await attempt('guess-10', ip)).status).toBe(429)
  })

  it('does not lock the class passcode because of wrong PINs from the same address', async () => {
    const ip = freshIp()
    const { id } = await profileWithPin('Pin Guessed', '1357')
    const pin = (code: string) => app.request(`/api/people/${id}/login`, json('POST', { pin: code }, { Cookie: member, 'x-real-ip': ip }))
    for (let i = 0; i < 10; i++) expect((await pin(String(9000 + i))).status).toBe(401)
    expect((await pin('1357')).status).toBe(429)
    expect((await attempt('class-pass', ip)).status).toBe(200)
  })
})

describe('body size limits', () => {
  it('refuses an oversized login body with 413 before reading the passcode', async () => {
    const res = await app.request('/api/login', json('POST', { passcode: 'class-pass', pad: 'x'.repeat(70 * 1024) }, { 'x-real-ip': freshIp() }))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(HEBREW)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('refuses an oversized JSON body on other API routes too', async () => {
    const res = await app.request('/api/tapes', json('POST', { url: 'x'.repeat(70 * 1024) }, { Cookie: member }))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(HEBREW)
  })

  it('still takes a real photo, and refuses one over the upload cap', async () => {
    const { token } = await profileWithPin('Big Photo', '1111')
    const headers = { Cookie: member, 'x-edit-token': token }
    const photo = await noisyPng()
    expect(photo.length).toBeGreaterThan(64 * 1024)
    const ok = await app.request('/api/me/photo/now', { method: 'POST', headers, body: upload('photo', photo) })
    expect(ok.status).toBe(200)

    const justOver = await app.request('/api/me/photo/now', { method: 'POST', headers, body: upload('photo', new Uint8Array(MAX_UPLOAD_BYTES + 1)) })
    expect([400, 413]).toContain(justOver.status)
    expect((await justOver.json()).error).toMatch(HEBREW)

    const huge = await app.request('/api/me/photo/now', { method: 'POST', headers, body: upload('photo', new Uint8Array(MAX_UPLOAD_BYTES + MB + 1)) })
    expect(huge.status).toBe(413)
    expect((await huge.json()).error).toMatch(HEBREW)
  })

  it('keeps the larger limits on the organizer uploads and imports', async () => {
    const person = insertPerson(db, { name: 'Admin Photo Target' })
    const photo = await app.request(`/api/admin/people/${person}/photo/then`, { method: 'POST', headers: { Cookie: admin }, body: upload('photo', await noisyPng()) })
    expect(photo.status).toBe(200)

    const scene = await app.request('/api/admin/scenes', { method: 'POST', headers: { Cookie: admin }, body: upload('image', await noisyPng(300, 300), { title: 'Noise' }) })
    expect(scene.status).toBe(201)

    const csv = ['name', 'Csv Person', ...Array.from({ length: 400 }, (_, i) => `,padding-${i}-${'x'.repeat(200)}`)].join('\n')
    expect(csv.length).toBeGreaterThan(64 * 1024)
    const imported = await app.request('/api/admin/import-csv', { method: 'POST', headers: { Cookie: admin }, body: csv })
    expect(imported.status).toBe(200)
    expect((await imported.json()).added).toBe(1)

    // Face detection sends unrounded coordinates, a few hundred faces per class photo.
    const boxes = Array.from({ length: 1000 }, (_, i) => ({ x: 1 + i / 3, y: 2 + i / 7, w: 30 + i / 11, h: 40 + i / 13 }))
    expect(JSON.stringify({ boxes }).length).toBeGreaterThan(64 * 1024)
    const batch = await app.request(`/api/admin/scenes/${(await scene.json()).id}/tags/batch`, json('POST', { boxes }, { Cookie: admin }))
    expect(batch.status).toBe(201)

    const faces = Array.from({ length: 600 }, (_, i) => ({ x: i / 3, y: i / 7, w: 30 + i / 11, h: 40 + i / 13, caption: `פלוני אלמוני ${i}`, classLabel: 'יב 3', staff: false, person: null }))
    const roster = { version: 1, people: [], scenes: [{ title: 'Elsewhere', year: null, width: 1000, height: 800, faces }] }
    expect(JSON.stringify(roster).length).toBeGreaterThan(64 * 1024)
    const rosterRes = await app.request('/api/admin/roster/import', json('POST', roster, { Cookie: admin }))
    expect(rosterRes.status).toBe(200)
    expect((await rosterRes.json()).facesUnmatched).toBe(600)
  })
})

describe('malformed input', () => {
  it('answers a JSON null body with 400 or 401, never a crash', async () => {
    const { token, id } = await profileWithPin('Null Target', '8642')
    const tag = insertTag(db, addScene('Null Scene'), { x: 10, y: 10, w: 50, h: 60 }, null)
    const cases: [string, string, Record<string, string>][] = [
      ['POST', '/api/login', { 'x-real-ip': freshIp() }],
      ['POST', `/api/people/${id}/login`, { Cookie: member, 'x-real-ip': freshIp() }],
      ['POST', '/api/signin', { Cookie: member }],
      ['POST', `/api/tags/${tag}/suggest`, { Cookie: member }],
      ['PUT', '/api/me/pin', { Cookie: member, 'x-edit-token': token }],
    ]
    for (const [method, url, headers] of cases) {
      for (const body of ['null', '[]', '7', '"text"']) {
        const res = await app.request(url, raw(method, body, headers))
        expect([400, 401], `${method} ${url} ${body}`).toContain(res.status)
        expect((await res.json()).error, `${method} ${url} ${body}`).not.toMatch(/Cannot read|TypeError|null/)
      }
    }
  })

  it('answers a malformed escape in a page address with 404', async () => {
    expect((await app.request('/%E0%A4%A')).status).toBe(404)
  })
})

describe('logout', () => {
  it('retires the device key it was sent with, and only that one', async () => {
    const { token: editToken, id } = await profileWithPin('Logging Out', '9753')
    const pinLogin = async () => {
      const res = await app.request(`/api/people/${id}/login`, json('POST', { pin: '9753' }, { Cookie: member, 'x-real-ip': freshIp() }))
      expect(res.status).toBe(200)
      return (await res.json()).token as string
    }
    const phone = await pinLogin()
    const laptop = await pinLogin()
    const me = (token: string) => app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': token } })
    expect((await me(phone)).status).toBe(200)

    const out = await app.request('/api/logout', { method: 'POST', headers: { Cookie: member, 'x-edit-token': phone } })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toContain('reunion_session=;')

    expect((await me(phone)).status).toBe(403)
    expect((await me(laptop)).status).toBe(200)
    expect((await me(editToken)).status).toBe(200)
  })
})
