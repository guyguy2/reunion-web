import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { insertTag } from '../server/scenes.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-leftovers-test-'))
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

let member: string
let admin: string

beforeAll(async () => {
  member = await login('class-pass')
  admin = await login('admin-pass')
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('organizer reset of a claimed profile', () => {
  it('also lifts the lock on the personal code, so the owner can sign in with a new one', async () => {
    const created = await app.request('/api/people', json('POST', { name: 'Locked Out Owner', pin: '2468' }, { Cookie: member }))
    const { person } = await created.json()
    const login = (pin: string, ip: string) => app.request(`/api/people/${person.id}/login`, json('POST', { pin }, { Cookie: member, 'x-real-ip': ip }))
    // Ten wrong guesses from ten addresses lock the profile, not any one address.
    for (let i = 0; i < 10; i++) expect((await login(String(1000 + i), `10.9.0.${i}`)).status).toBe(401)
    expect((await login('2468', '10.9.1.1')).status).toBe(429)

    expect((await app.request(`/api/admin/people/${person.id}/reset-claim`, { method: 'POST', headers: { Cookie: admin } })).status).toBe(200)
    // The code went with the claim, and the answer says so rather than to wait.
    expect((await login('2468', '10.9.1.2')).status).toBe(400)

    const claimed = await app.request(`/api/people/${person.id}/claim`, json('POST', { pin: '1357' }, { Cookie: member }))
    expect(claimed.status).toBe(200)
    expect((await login('1357', '10.9.1.3')).status).toBe(200)
  })
})

describe('naming a face', () => {
  it('answers in Hebrew when the chosen profile does not exist', async () => {
    const scene = Number(
      db
        .prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort) VALUES ('s-trip', 'Class trip', 'group', 1000, 800, 'scenes/s-trip', 1)`)
        .run().lastInsertRowid,
    )
    const face = insertTag(db, scene, { x: 100, y: 100, w: 50, h: 60 }, null)
    const res = await app.request(`/api/tags/${face}/suggest`, json('POST', { personId: 999999 }, { Cookie: member }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'הפרופיל לא נמצא' })
  })
})
