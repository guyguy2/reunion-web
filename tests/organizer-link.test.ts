import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import type { Mailer } from '../server/email.ts'
import { getPerson, insertPerson } from '../server/people.ts'
import type { Person } from '../web/src/api.ts'
import SignInLink, { LinkToPass } from '../web/src/components/SignInLink.tsx'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-organizer-link-test-'))
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
// No email set up: the organizer's link is for the classmate an email cannot reach.
const app = createApp(config, db)
type App = typeof app
const MINUTE = 60 * 1000

async function login(passcode: string, ip: string, target: App = app): Promise<string> {
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

let member: string
let admin: string

beforeAll(async () => {
  member = await login('class-pass', '10.70.0.1')
  admin = await login('admin-pass', '10.70.0.2')
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('sign-in link made by an organizer', () => {
  const create = (id: number, headers: Record<string, string> = { Cookie: admin }, target: App = app) =>
    target.request(`/api/admin/people/${id}/signin-link`, { method: 'POST', headers })
  const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
  const signin = (url: string) => app.request('/api/signin', json('POST', { token: tokenOf(url) }, { Cookie: member, 'x-real-ip': '10.70.0.3' }))
  const me = (key: string) => app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': key } })
  const links = (id: number) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_tokens WHERE person_id = ?').get(id) as { n: number }).n

  it('gives a link that signs the classmate in once, with no email on the profile or the site', async () => {
    const id = insertPerson(db, { name: 'Morgan Blake', claimed_at: new Date().toISOString() })
    const asked = Date.now()
    const res = await create(id)
    expect(res.status).toBe(200)
    const link = await res.json()
    expect(link).toEqual({ url: expect.stringMatching(/^https:\/\/example\.test\/signin\/[\w-]+$/), expiresAt: expect.stringMatching(/Z$/), name: 'Morgan Blake' })
    // Thirty minutes, give or take the second the database rounds to.
    expect(Date.parse(link.expiresAt) - asked).toBeGreaterThan(29 * MINUTE)
    expect(Date.parse(link.expiresAt) - asked).toBeLessThanOrEqual(30 * MINUTE + 1000)

    const used = await signin(link.url)
    expect(used.status).toBe(200)
    const { token } = await used.json()
    expect((await (await me(token)).json()).id).toBe(id)
    expect((await signin(link.url)).status).toBe(400)
  })

  it('keeps the personal code and every device already signed in', async () => {
    const made = await app.request('/api/people', json('POST', { name: 'Quinn Harper', pin: '2468' }, { Cookie: member }))
    expect(made.status).toBe(201)
    const { person, token: firstDevice } = await made.json()
    const pinHash = getPerson(db, person.id)!.pin_hash

    const link = await (await create(person.id)).json()
    const used = await signin(link.url)
    expect(used.status).toBe(200)

    expect((await me(firstDevice)).status).toBe(200)
    expect(getPerson(db, person.id)!.pin_hash).toBe(pinHash)
    const pinLogin = await app.request(`/api/people/${person.id}/login`, json('POST', { pin: '2468' }, { Cookie: member, 'x-real-ip': '10.70.0.4' }))
    expect(pinLogin.status).toBe(200)
  })

  it('cancels the links made before it, emailed or not, and has no cooldown', async () => {
    const outbox: Parameters<Mailer>[0][] = []
    const mailApp = createApp(config, db, async (m) => void outbox.push(m))
    const id = insertPerson(db, { name: 'Rowan Ellis', email: 'rowan@example.test', claimed_at: new Date().toISOString() })
    const emailed = await mailApp.request(`/api/people/${id}/signin-link`, { method: 'POST', headers: { Cookie: member, 'x-real-ip': '10.70.0.5' } })
    expect(emailed.status).toBe(200)
    const emailedUrl = outbox[0].text.match(/https:\/\/example\.test\/signin\/\S+/)![0]

    const first = await (await create(id)).json()
    const second = await create(id)
    expect(second.status).toBe(200)
    const latest = await second.json()
    expect(links(id)).toBe(1)

    expect((await signin(emailedUrl)).status).toBe(400)
    expect((await signin(first.url)).status).toBe(400)
    expect((await signin(latest.url)).status).toBe(200)
  })

  it('refuses a profile nobody has claimed, in Hebrew, and makes no link', async () => {
    const id = insertPerson(db, { name: 'Sky Parker' })
    const res = await create(id)
    expect(res.status).toBe(409)
    const { error } = await res.json()
    expect(error).toMatch(/[֐-׿]/)
    expect(links(id)).toBe(0)
  })

  it('answers Not found for a profile that does not exist', async () => {
    const res = await create(987_654)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('is for organizers only', async () => {
    const id = insertPerson(db, { name: 'Drew Foster', claimed_at: new Date().toISOString() })
    const asMember = await create(id, { Cookie: member })
    expect(asMember.status).toBe(403)
    expect(await asMember.json()).toEqual({ error: 'למארגנים בלבד' })
    const anonymous = await create(id, {})
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: 'נדרשת סיסמה' })
    expect(links(id)).toBe(0)
  })

  it('refuses with the general error and one log line when the site has no public address', async () => {
    const noUrl = createApp({ ...config, publicUrl: undefined }, db)
    const organizer = await login('admin-pass', '10.70.0.6', noUrl)
    const id = insertPerson(db, { name: 'Reese Walker', claimed_at: new Date().toISOString() })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await create(id, { Cookie: organizer }, noUrl)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'משהו השתבש' })
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
    expect(links(id)).toBe(0)
  })
})

describe('sign-in link on the roster', () => {
  const link = { url: 'https://example.test/signin/abc-123', expiresAt: '2026-10-01T18:30:00Z', name: 'Morgan Blake' }

  it('shows the link read-only with a copy button, whose it is, and how long it works', () => {
    const html = renderToStaticMarkup(createElement(LinkToPass, { link, copied: false, onCopy: () => {} }))
    expect(html).toMatch(/<input[^>]*readOnly=""[^>]*value="https:\/\/example\.test\/signin\/abc-123"/)
    expect(html).toContain('Morgan Blake')
    expect(html).toContain('>העתקה</button>')
    expect(html).toContain('הקישור עובד פעם אחת ותקף 30 דקות. שלחו אותו רק למי שהפרופיל שלו.')
    expect(renderToStaticMarkup(createElement(LinkToPass, { link, copied: true, onCopy: () => {} }))).toContain('>הועתק</button>')
  })

  it('starts as a button, which waits while another roster action runs', () => {
    const person = { id: 7, name: 'Morgan Blake', claimed: true } as Person
    const render = (busy: boolean) => renderToStaticMarkup(createElement(SignInLink, { person, once: async () => {}, busy }))
    expect(render(false)).toMatch(/<button[^>]*>צרו קישור כניסה<\/button>/)
    expect(render(false)).not.toContain('disabled')
    expect(render(true)).toMatch(/<button[^>]*disabled=""[^>]*>צרו קישור כניסה<\/button>/)
    expect(render(false)).not.toContain('signin/')
  })
})
