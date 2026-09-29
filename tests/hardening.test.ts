import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import { clientKey, createLoginLimiter, createThrottle } from '../server/auth.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import type { Mailer } from '../server/email.ts'
import { insertPerson } from '../server/people.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-hardening-test-'))
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
type App = typeof app
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const TOO_MANY_REQUESTS = { error: 'יותר מדי בקשות. נסו שוב מאוחר יותר.' }
const TOO_MANY_TRIES = { error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }

// Every throttle test gets addresses of its own, so no test inherits another's count.
let lastIp = 0
const freshIp = () => `10.60.${Math.floor(lastIp / 250)}.${(lastIp++ % 250) + 1}`

async function login(passcode: string, ip = freshIp(), target: App = app): Promise<string> {
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

/** An app whose email goes to `outbox` instead of out. */
function mailApp(overrides: Partial<Config> = {}) {
  const outbox: Parameters<Mailer>[0][] = []
  return { outbox, app: createApp({ ...config, ...overrides }, db, async (m) => void outbox.push(m)) }
}

let member: string

beforeAll(async () => {
  member = await login('class-pass')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('client key', () => {
  it('takes the last x-forwarded-for hop, the one the proxy added, over x-real-ip', async () => {
    const keyed = new Hono().get('/', (c) => c.text(clientKey(c)))
    const key = async (headers: Record<string, string>) => (await keyed.request('/', { headers })).text()
    expect(await key({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'x-real-ip': '9.9.9.9' })).toBe('2.2.2.2')
    expect(await key({ 'x-real-ip': '9.9.9.9' })).toBe('9.9.9.9')
    expect(await key({})).toBe('local')
  })

  it('does not give more passcode guesses to a client that makes up its address', async () => {
    const proxied = (spoofed: string) => ({ 'x-forwarded-for': `${spoofed}, 10.61.0.1`, 'x-real-ip': spoofed })
    for (let i = 0; i < 10; i++) {
      expect((await app.request('/api/login', json('POST', { passcode: 'nope' }, proxied(`1.1.1.${i}`)))).status).toBe(401)
    }
    const blocked = await app.request('/api/login', json('POST', { passcode: 'class-pass' }, proxied('1.1.1.99')))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual(TOO_MANY_TRIES)
  })
})

describe('login limiter', () => {
  it('forgets an address once its failures age out, and never stores one it only looked up', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const limiter = createLoginLimiter()
    expect(limiter.blocked('never-failed')).toBe(false)
    expect(limiter.size()).toBe(0)

    limiter.fail('a')
    expect(limiter.size()).toBe(1)
    vi.setSystemTime(Date.now() + 15 * MINUTE + 1)
    expect(limiter.blocked('a')).toBe(false)
    expect(limiter.size()).toBe(0)

    // A forgotten address counts again from scratch.
    for (let i = 0; i < 10; i++) limiter.fail('a')
    expect(limiter.blocked('a')).toBe(true)
  })
})

describe('throttle', () => {
  it('allows max hits per key in the window, and each key again once its hits age out or are cleared', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const throttle = createThrottle({ max: 2, windowMs: MINUTE })
    expect([throttle.allow('a'), throttle.allow('a'), throttle.allow('a')]).toEqual([true, true, false])
    expect(throttle.allow('b')).toBe(true)

    vi.setSystemTime(Date.now() + MINUTE + 1)
    expect([throttle.allow('a'), throttle.allow('a'), throttle.allow('a')]).toEqual([true, true, false])
    throttle.clear('a')
    expect(throttle.allow('a')).toBe(true)
  })

  it('caps all keys together at globalMax, and a refused hit is not counted', () => {
    const throttle = createThrottle({ max: 1, windowMs: MINUTE, globalMax: 2 })
    expect([throttle.allow('a'), throttle.allow('a'), throttle.allow('b'), throttle.allow('c')]).toEqual([true, false, true, false])
    throttle.clear('a')
    // Clearing a key gives that key its own hits back, not the ones counted for everyone.
    expect(throttle.allow('a')).toBe(false)
  })

  it('keeps no key that is left without hits', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const throttle = createThrottle({ max: 5, windowMs: MINUTE, globalMax: 1 })
    expect(throttle.allow('a')).toBe(true)
    // Refused for everyone's count: nothing to keep for b.
    expect(throttle.allow('b')).toBe(false)
    expect(throttle.size()).toBe(1)

    // a's hit has aged out, and b's hit fills everyone's count, so a is looked at, refused, and dropped.
    vi.setSystemTime(Date.now() + MINUTE + 1)
    expect(throttle.allow('b')).toBe(true)
    expect(throttle.allow('a')).toBe(false)
    expect(throttle.size()).toBe(1)
    throttle.clear('b')
    expect(throttle.size()).toBe(0)
  })
})

describe('feedback throttle', () => {
  const post = (target: App, ip: string) =>
    target.request('/api/feedback', json('POST', { message: 'The mixtape skips' }, { Cookie: member, 'x-real-ip': ip }))
  const saved = () => (db.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number }).n

  it('takes three messages per address in ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fresh = createApp(config, db)
    const ip = freshIp()
    for (let i = 0; i < 3; i++) expect((await post(fresh, ip)).status).toBe(201)
    const before = saved()
    const refused = await post(fresh, ip)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
    expect(saved()).toBe(before)

    expect((await post(fresh, freshIp())).status).toBe(201)
    vi.setSystemTime(Date.now() + 10 * MINUTE + 1)
    expect((await post(fresh, ip)).status).toBe(201)
  })

  it('takes fifty messages a day from everyone together', async () => {
    const fresh = createApp(config, db)
    for (let i = 0; i < 50; i++) expect((await post(fresh, freshIp())).status).toBe(201)
    const refused = await post(fresh, freshIp())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
  })
})

describe('sign-in link throttle', () => {
  const link = (target: App, personId: number, ip: string) =>
    target.request(`/api/people/${personId}/signin-link`, { method: 'POST', headers: { Cookie: member, 'x-real-ip': ip } })
  const claimed = (name: string, email: string | null) => insertPerson(db, { name, email, claimed_at: 'now' })

  it('takes three requests per address in ten minutes, and answers the same whether or not the profile has an email', async () => {
    const { app: fresh, outbox } = mailApp()
    const withEmail = claimed('Jenny Carter', 'jenny@example.test')
    const noEmail = claimed('Casey Morgan', null)
    const ip = freshIp()
    for (let i = 0; i < 3; i++) expect((await link(fresh, noEmail, ip)).status).toBe(400)

    const toEmail = await link(fresh, withEmail, ip)
    const toNoEmail = await link(fresh, noEmail, ip)
    expect([toEmail.status, toNoEmail.status]).toEqual([429, 429])
    expect(await toEmail.json()).toEqual(TOO_MANY_REQUESTS)
    expect(await toNoEmail.json()).toEqual(TOO_MANY_REQUESTS)
    expect(outbox).toHaveLength(0)

    expect((await link(fresh, withEmail, freshIp())).status).toBe(200)
    expect(outbox).toHaveLength(1)
  })

  it('takes five requests a day for one profile, from any number of addresses', async () => {
    const { app: fresh } = mailApp()
    const target = claimed('Riley Brooks', 'riley@example.test')
    expect((await link(fresh, target, freshIp())).status).toBe(200)
    // The rest wait out the two-minute cooldown, and still count.
    for (let i = 0; i < 4; i++) expect((await link(fresh, target, freshIp())).status).toBe(400)
    const refused = await link(fresh, target, freshIp())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
    expect((await link(fresh, claimed('Avery Lane', 'avery@example.test'), freshIp())).status).toBe(200)
  })

  it('takes a hundred requests a day from everyone together', async () => {
    const { app: fresh } = mailApp()
    const target = claimed('Jordan Hale', 'jordan@example.test')
    for (let i = 0; i < 100; i++) expect((await link(fresh, 900_000 + i, freshIp())).status).toBe(404)
    const refused = await link(fresh, target, freshIp())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
  })

  it('clears the count for the address once a link from it is used', async () => {
    const { app: fresh, outbox } = mailApp()
    const target = claimed('Dana Ellis', 'dana@example.test')
    const ip = freshIp()
    expect((await link(fresh, target, ip)).status).toBe(200)
    for (let i = 0; i < 2; i++) expect((await link(fresh, target, ip)).status).toBe(400)
    expect((await link(fresh, target, ip)).status).toBe(429)

    const token = outbox[0].text.match(/signin\/(\S+)/)![1]
    expect((await fresh.request('/api/signin', json('POST', { token }, { Cookie: member, 'x-real-ip': ip }))).status).toBe(200)
    expect((await link(fresh, target, ip)).status).toBe(200)
    expect(outbox).toHaveLength(2)
  })
})

describe('session cookie and passcode changes', () => {
  const role = async (target: App, cookie: string) => (await (await target.request('/api/session', { headers: { Cookie: cookie } })).json()).role

  it('logs out the role whose passcode changed, and only that role', async () => {
    const classCookie = await login('class-pass')
    const adminCookie = await login('admin-pass')

    const newClass = createApp({ ...config, classPasscode: 'new-class-pass' }, db)
    expect(await role(newClass, classCookie)).toBeNull()
    expect((await newClass.request('/api/people', { headers: { Cookie: classCookie } })).status).toBe(401)
    expect(await role(newClass, adminCookie)).toBe('admin')

    const newAdmin = createApp({ ...config, adminPasscode: 'new-admin-pass' }, db)
    expect(await role(newAdmin, adminCookie)).toBeNull()
    expect((await newAdmin.request('/api/admin/stats', { headers: { Cookie: adminCookie } })).status).toBe(401)
    expect(await role(newAdmin, classCookie)).toBe('member')

    expect(await role(app, classCookie)).toBe('member')
    expect(await role(app, adminCookie)).toBe('admin')
  })
})

describe('PIN lockout per profile', () => {
  async function profileWithPin(name: string, pin: string): Promise<number> {
    const res = await app.request('/api/people', json('POST', { name, pin }, { Cookie: member }))
    expect(res.status).toBe(201)
    return (await res.json()).person.id
  }
  // A new address every time, so only the profile's own count is in play.
  const pinLogin = (id: number, pin: string) =>
    app.request(`/api/people/${id}/login`, json('POST', { pin }, { Cookie: member, 'x-real-ip': freshIp() }))

  it('blocks after 10 wrong codes, then doubles the block with each wrong code up to a day, until the right one', async () => {
    const id = await profileWithPin('Sam Carter', '2468')
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let i = 0; i < 10; i++) expect((await pinLogin(id, '0000')).status).toBe(401)

    for (const minutes of [15, 30, 60, 120, 240, 480, 960, 1440, 1440]) {
      vi.setSystemTime(Date.now() + minutes * MINUTE - 1000)
      const blocked = await pinLogin(id, '2468')
      expect(blocked.status, `${minutes} minutes`).toBe(429)
      expect(await blocked.json()).toEqual(TOO_MANY_TRIES)
      vi.setSystemTime(Date.now() + 1000)
      // The block is over, and this wrong code starts the next one.
      expect((await pinLogin(id, '0000')).status, `${minutes} minutes`).toBe(401)
    }

    vi.setSystemTime(Date.now() + DAY)
    expect((await pinLogin(id, '2468')).status).toBe(200)
    // The right code wiped the slate: one wrong code is just a wrong code again.
    expect((await pinLogin(id, '0000')).status).toBe(401)
    expect((await pinLogin(id, '2468')).status).toBe(200)
  })

  it('starts a profile over a day after its last block ran out', async () => {
    const id = await profileWithPin('Owen Price', '1357')
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let i = 0; i < 10; i++) expect((await pinLogin(id, '0000')).status).toBe(401)
    vi.setSystemTime(Date.now() + 15 * MINUTE + DAY)
    expect((await pinLogin(id, '0000')).status).toBe(401)
    expect((await pinLogin(id, '1357')).status).toBe(200)
  })
})
