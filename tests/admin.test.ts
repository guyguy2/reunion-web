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
