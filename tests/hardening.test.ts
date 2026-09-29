import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import { clientKey, createLockout, createLoginLimiter, createThrottle, sha256 } from '../server/auth.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { gmailRelayMailer, type Mailer } from '../server/email.ts'
import { getPerson, insertPerson } from '../server/people.ts'

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
  it('takes x-real-ip, which Railway sets, over x-forwarded-for, and else the last x-forwarded-for hop', async () => {
    const keyed = new Hono().get('/', (c) => c.text(clientKey(c)))
    const key = async (headers: Record<string, string>) => (await keyed.request('/', { headers })).text()
    expect(await key({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'x-real-ip': '9.9.9.9' })).toBe('9.9.9.9')
    expect(await key({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })).toBe('2.2.2.2')
    expect(await key({ 'x-real-ip': '9.9.9.9' })).toBe('9.9.9.9')
    expect(await key({})).toBe('local')
  })

  it('does not give more passcode guesses to a client that makes up x-forwarded-for', async () => {
    const proxied = (spoofed: string) => ({ 'x-forwarded-for': `${spoofed}, ${spoofed}`, 'x-real-ip': '10.61.0.1' })
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

describe('limiter memory', () => {
  it('sweeps out keys whose window has passed once a limiter holds more than 10000', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const limiter = createLoginLimiter()
    const throttle = createThrottle({ max: 5, windowMs: 15 * MINUTE })
    const lockout = createLockout()
    const add = (key: string) => {
      limiter.fail(key)
      throttle.hit(key)
      lockout.fail(key)
    }
    const sizes = () => [limiter.size(), throttle.size(), lockout.size()]

    for (let i = 0; i <= 10_000; i++) add(`10.62.${i}`)
    // Past 10000, but every key is still in its window: nothing goes.
    expect(sizes()).toEqual([10_001, 10_001, 10_001])

    vi.setSystemTime(Date.now() + 15 * MINUTE + 1)
    add('10.63.0.1')
    expect(sizes()).toEqual([1, 1, 1])
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

  it('checks without counting, and counts only the hits it is told of', () => {
    const throttle = createThrottle({ max: 1, windowMs: MINUTE, globalMax: 2 })
    expect([throttle.check('a'), throttle.check('a')]).toEqual([true, true])
    throttle.hit('a')
    expect(throttle.check('a')).toBe(false)
    throttle.hit('b')
    // Everyone's count is full too.
    expect(throttle.check('c')).toBe(false)
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

  it('takes ten messages per address in ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fresh = createApp(config, db)
    const ip = freshIp()
    for (let i = 0; i < 10; i++) expect((await post(fresh, ip)).status).toBe(201)
    const before = saved()
    const refused = await post(fresh, ip)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
    expect(saved()).toBe(before)

    expect((await post(fresh, freshIp())).status).toBe(201)
    vi.setSystemTime(Date.now() + 10 * MINUTE + 1)
    expect((await post(fresh, ip)).status).toBe(201)
  })

  it('emails fifty messages a day from everyone together, and still saves the rest', async () => {
    const { app: fresh, outbox } = mailApp({ feedbackTo: 'organizers@example.test' })
    for (let i = 0; i < 50; i++) {
      const res = await post(fresh, freshIp())
      expect(res.status).toBe(201)
      expect((await res.json()).emailed).toBe(true)
    }
    const before = saved()
    const over = await post(fresh, freshIp())
    expect(over.status).toBe(201)
    expect(await over.json()).toMatchObject({ message: 'The mixtape skips', emailed: false })
    expect(saved()).toBe(before + 1)
    expect(outbox).toHaveLength(50)
  })

  it('does not count feedback it refused against the daily email limit', async () => {
    const { app: fresh, outbox } = mailApp({ feedbackTo: 'organizers@example.test' })
    for (let i = 0; i < 50; i++) {
      expect((await fresh.request('/api/feedback', json('POST', { message: '   ' }, { Cookie: member, 'x-real-ip': freshIp() }))).status).toBe(400)
    }
    expect(await (await post(fresh, freshIp())).json()).toMatchObject({ emailed: true })
    expect(outbox).toHaveLength(1)
  })
})

describe('sign-in link throttle', () => {
  const link = (target: App, personId: number, ip: string) =>
    target.request(`/api/people/${personId}/signin-link`, { method: 'POST', headers: { Cookie: member, 'x-real-ip': ip } })
  const claimed = (name: string, email: string | null) => insertPerson(db, { name, email, claimed_at: 'now' })
  /** Moves the profile's last link out of the two-minute cooldown, so the next request sends again. */
  const pastCooldown = (id: number) => db.prepare("UPDATE recovery_tokens SET created_at = datetime('now', '-1 hour') WHERE person_id = ?").run(id)

  it('takes ten requests per address in ten minutes, and answers the same whether or not the profile has an email', async () => {
    const { app: fresh, outbox } = mailApp()
    const withEmail = claimed('Jenny Carter', 'jenny@example.test')
    const noEmail = claimed('Casey Morgan', null)
    const ip = freshIp()
    // Spread over profiles that do not exist, so no one profile reaches its own limit.
    for (let i = 0; i < 10; i++) expect((await link(fresh, 800_000 + i, ip)).status).toBe(404)

    const toEmail = await link(fresh, withEmail, ip)
    const toNoEmail = await link(fresh, noEmail, ip)
    expect([toEmail.status, toNoEmail.status]).toEqual([429, 429])
    expect(await toEmail.json()).toEqual(TOO_MANY_REQUESTS)
    expect(await toNoEmail.json()).toEqual(TOO_MANY_REQUESTS)
    expect(outbox).toHaveLength(0)

    expect((await link(fresh, withEmail, freshIp())).status).toBe(200)
    expect(outbox).toHaveLength(1)
  })

  it('sends five links a day for one profile, from any number of addresses', async () => {
    const { app: fresh, outbox } = mailApp()
    const target = claimed('Riley Brooks', 'riley@example.test')
    for (let i = 0; i < 5; i++) {
      expect((await link(fresh, target, freshIp())).status).toBe(200)
      pastCooldown(target)
    }
    const refused = await link(fresh, target, freshIp())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
    expect(outbox).toHaveLength(5)
    expect((await link(fresh, claimed('Avery Lane', 'avery@example.test'), freshIp())).status).toBe(200)
  })

  it('sends a hundred links a day from everyone together', async () => {
    const { app: fresh, outbox } = mailApp()
    for (let i = 0; i < 100; i++) {
      expect((await link(fresh, claimed(`Classmate ${i}`, `classmate${i}@example.test`), freshIp())).status).toBe(200)
    }
    const refused = await link(fresh, claimed('Jordan Hale', 'jordan@example.test'), freshIp())
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual(TOO_MANY_REQUESTS)
    expect(outbox).toHaveLength(100)
  })

  it('does not count a refused request against the address', async () => {
    const { app: fresh } = mailApp()
    const full = claimed('Sam Carter', 'sam@example.test')
    for (let i = 0; i < 5; i++) {
      expect((await link(fresh, full, freshIp())).status).toBe(200)
      pastCooldown(full)
    }
    const ip = freshIp()
    for (let i = 0; i < 10; i++) expect((await link(fresh, full, ip)).status).toBe(429)
    expect((await link(fresh, claimed('Owen Price', 'owen@example.test'), ip)).status).toBe(200)
  })

  it('counts only the emails it tries to send against the profile and everyone, failed ones included', async () => {
    let emailDown = false
    const fresh = createApp(config, db, async () => {
      if (emailDown) throw new Error('relay down')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Nothing is sent to profiles that do not exist, to one without an email, or during the cooldown.
    for (let i = 0; i < 100; i++) expect((await link(fresh, 910_000 + i, freshIp())).status).toBe(404)
    const noEmail = claimed('Lee Porter', null)
    for (let i = 0; i < 6; i++) expect((await link(fresh, noEmail, freshIp())).status).toBe(400)
    const target = claimed('Dana Ellis', 'dana.e@example.test')
    expect((await link(fresh, target, freshIp())).status).toBe(200)
    for (let i = 0; i < 5; i++) expect((await link(fresh, target, freshIp())).status).toBe(400)
    for (let i = 0; i < 3; i++) {
      pastCooldown(target)
      expect((await link(fresh, target, freshIp())).status).toBe(200)
    }

    // The fifth email fails, and still counts: the relay may have sent it.
    pastCooldown(target)
    emailDown = true
    expect(await (await link(fresh, target, freshIp())).json()).toEqual({ error: 'לא הצלחנו לשלוח את המייל. נסו שוב בעוד רגע.' })
    emailDown = false
    expect((await link(fresh, target, freshIp())).status).toBe(429)
  })

  it('clears the count for the address once a link is used from it', async () => {
    const { app: fresh, outbox } = mailApp()
    const target = claimed('Dana Ellis', 'dana@example.test')
    // Asked for on one device, opened on another.
    expect((await link(fresh, target, freshIp())).status).toBe(200)
    const ip = freshIp()
    for (let i = 0; i < 10; i++) expect((await link(fresh, 810_000 + i, ip)).status).toBe(404)
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

  it('carries the passcode only as a hash keyed with the session secret', async () => {
    const payloadOf = (cookie: string) => {
      const value = decodeURIComponent(cookie.slice('reunion_session='.length))
      return value.slice(0, value.lastIndexOf('.'))
    }
    const keyed = (passcode: string) => crypto.createHmac('sha256', config.sessionSecret).update(passcode).digest('hex')
    for (const [passcode, issuedRole] of [['class-pass', 'member'], ['admin-pass', 'admin']]) {
      const payload = payloadOf(await login(passcode))
      expect(payload).not.toContain(sha256(passcode))
      expect(payload.split(':')).toEqual([issuedRole, expect.stringMatching(/^\d+$/), keyed(passcode)])
    }
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

describe('links in emails without a public address', () => {
  const recoveryLinks = (id: number) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_tokens WHERE person_id = ?').get(id) as { n: number }).n

  it('refuses a sign-in link with the general error and one log line, and sends nothing', async () => {
    const { app: noUrl, outbox } = mailApp({ publicUrl: undefined })
    const id = insertPerson(db, { name: 'Jenny Carter', email: 'jenny.c@example.test', claimed_at: 'now' })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await noUrl.request(`/api/people/${id}/signin-link`, { method: 'POST', headers: { Cookie: member, 'x-real-ip': freshIp() } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'משהו השתבש' })
    expect(logged).toHaveBeenCalledTimes(1)
    expect(outbox).toHaveLength(0)
    expect(recoveryLinks(id)).toBe(0)
  })

  it('delivers a note but skips its email alert, with one log line', async () => {
    const { app: noUrl, outbox } = mailApp({ publicUrl: undefined })
    const id = insertPerson(db, { name: 'Pen Pal', email: 'penpal@example.test' })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await noUrl.request('/api/notes', json('POST', { to: id, message: 'See you there', anonymous: true }, { Cookie: member }))
    expect(res.status).toBe(201)
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE recipient_id = ?').get(id)).toEqual({ n: 1 })
    expect(outbox).toHaveLength(0)
    expect(logged).toHaveBeenCalledTimes(1)
  })
})

describe('feedback email', () => {
  it('goes out through the mailer the app was given', async () => {
    const { app: withMail, outbox } = mailApp({ feedbackTo: 'organizers@example.test' })
    const res = await withMail.request(
      '/api/feedback',
      json('POST', { message: 'Love the wall', sender: 'Jenny <jenny@example.test>' }, { Cookie: member, 'x-real-ip': freshIp() }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ emailed: true })
    expect(outbox).toEqual([
      expect.objectContaining({ to: 'organizers@example.test', replyTo: 'jenny@example.test', text: expect.stringContaining('Love the wall') }),
    ])
  })
})

describe('sign-in link deadline', () => {
  it('gives up one minute after it started, however many relay redirects that takes', async () => {
    const exec = 'https://script.google.com/macros/s/ID/exec'
    const moved = 'https://script.google.com/macros/u/1/s/ID/exec'
    // Google moves the POST after 40 seconds, and the moved one never answers. Each request would stop in time on its own.
    let reached = () => {}
    const relayReached = new Promise<void>((resolve) => (reached = resolve))
    const stallingFetch = ((url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        if (url !== exec) return
        reached()
        setTimeout(() => resolve(new Response(null, { status: 302, headers: { location: moved } })), 40_000)
      })) as unknown as typeof fetch
    const relay = gmailRelayMailer({ ...config, gmailRelayUrl: exec, gmailRelaySecret: 'relay-secret' }, stallingFetch)!
    const slow = createApp(config, db, relay)
    const id = insertPerson(db, { name: 'Jordan Hale', email: 'jordan.h@example.test', claimed_at: 'now' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    let answer: Response | undefined
    void Promise.resolve(slow.request(`/api/people/${id}/signin-link`, { method: 'POST', headers: { Cookie: member, 'x-real-ip': freshIp() } })).then(
      (res) => (answer = res),
    )
    // The session check runs on real time first; the clock starts once the email is on its way.
    await relayReached
    await vi.advanceTimersByTimeAsync(59_000)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(answer?.status).toBe(400)
    expect(await answer!.json()).toEqual({ error: 'לא הצלחנו לשלוח את המייל. נסו שוב בעוד רגע.' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_tokens WHERE person_id = ?').get(id)).toEqual({ n: 0 })
  })
})

describe('error messages', () => {
  it('passes our own Hebrew message through, and answers anything else with a general one it logs', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const add = (text: string) => app.request('/api/quotes', json('POST', { text }, { Cookie: member }))

    const empty = await add('')
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: 'מה אמרו? כתבו את המשפט' })
    expect(logged).not.toHaveBeenCalled()

    db.exec(`CREATE TEMP TRIGGER quotes_fail BEFORE INSERT ON quotes BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END`)
    try {
      const failed = await add('We will meet again')
      expect(failed.status).toBe(400)
      expect(await failed.json()).toEqual({ error: 'הבקשה לא תקינה' })
    } finally {
      db.exec('DROP TRIGGER quotes_fail')
    }
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0].join(' ')).toContain('simulated database failure')
  })
})

describe('profile photo upload errors', () => {
  const upload = async (kind: string, file: File) => {
    const created = await app.request('/api/people', json('POST', { name: 'Riley Brooks' }, { Cookie: member }))
    const form = new FormData()
    form.set('photo', file)
    return app.request(`/api/me/photo/${kind}`, { method: 'POST', headers: { Cookie: member, 'x-edit-token': (await created.json()).token }, body: form })
  }

  it('names an unknown photo kind in Hebrew', async () => {
    const res = await upload('later', new File(['not really a png'], 'fake.png', { type: 'image/png' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'סוג תמונה לא מוכר' })
  })

  it('says in Hebrew that bytes which only claim to be an image are not one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await upload('now', new File(['not really a png'], 'fake.png', { type: 'image/png' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'הקובץ אינו תמונה תקינה' })
  })
})

describe('remove my info', () => {
  async function ownProfile(name: string, formerName: string): Promise<{ id: number; token: string }> {
    const created = await app.request('/api/people', json('POST', { name }, { Cookie: member }))
    const { token, person } = await created.json()
    const patched = await app.request('/api/me', json('PATCH', { formerName, city: 'Haifa' }, { Cookie: member, 'x-edit-token': token }))
    expect(await patched.json()).toMatchObject({ formerName, city: 'Haifa' })
    return { id: person.id, token }
  }
  const remove = (token: string) => app.request('/api/me', { method: 'DELETE', headers: { Cookie: member, 'x-edit-token': token } })
  /** Uploads a real "now" photo as the owner and returns its path under the data folder. */
  async function uploadNow(token: string): Promise<string> {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#14b8a6' } }).png().toBuffer()
    const form = new FormData()
    form.set('photo', new File([new Uint8Array(png)], 'photo.png', { type: 'image/png' }))
    const res = await app.request('/api/me/photo/now', { method: 'POST', headers: { Cookie: member, 'x-edit-token': token }, body: form })
    expect(res.status).toBe(200)
    return (await res.json()).nowPhotos.at(-1).url.slice('/media/'.length)
  }
  const onDisk = (rel: string) => fs.existsSync(path.join(dataDir, rel))

  it('clears the former name too, keeps the photos an organizer added, and frees the profile to be claimed', async () => {
    const { id, token } = await ownProfile('Jenny Carter', 'Jenny Miller')
    const own = await uploadNow(token)
    db.prepare("INSERT INTO person_photos (person_id, kind, path) VALUES (?, 'then', 'uploads/organizer-then.webp')").run(id)

    expect((await remove(token)).status).toBe(200)
    expect(getPerson(db, id)).toMatchObject({ name: 'Jenny Carter', former_name: null, city: null, now_photo: null, claimed_at: null, edit_token_hash: null })
    expect(getPerson(db, id)?.photos).toMatchObject([{ kind: 'then', path: 'uploads/organizer-then.webp' }])
    expect(onDisk(own)).toBe(false)
    expect((await app.request(`/api/people/${id}/claim`, json('POST', { pin: '2468' }, { Cookie: member }))).status).toBe(200)
  })

  it('changes nothing and deletes no photo file when a step fails part way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A step before the photos, and one among them, after the first photo's row is already gone.
    for (const step of ['device keys', 'second photo'] as const) {
      const { id, token } = await ownProfile('Casey Morgan', 'Casey Brown')
      db.prepare('INSERT INTO device_tokens (token_hash, person_id) VALUES (?, ?)').run(`hardening-device-key-${step}`, id)
      const photos = [await uploadNow(token), await uploadNow(token)]
      const before = getPerson(db, id)

      const on = step === 'device keys' ? 'device_tokens' : `person_photos WHEN OLD.path = '${photos[1]}'`
      db.exec(`CREATE TEMP TRIGGER remove_fails BEFORE DELETE ON ${on} BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`)
      try {
        const res = await remove(token)
        expect(res.status, step).toBe(500)
        expect(await res.json(), step).toEqual({ error: 'משהו השתבש' })
      } finally {
        db.exec('DROP TRIGGER remove_fails')
      }
      expect(getPerson(db, id), step).toEqual(before)
      for (const rel of photos) expect(onDisk(rel), `${step}: ${rel}`).toBe(true)
      expect((await app.request('/api/me', { headers: { Cookie: member, 'x-edit-token': token } })).status, step).toBe(200)
    }
  })
})
