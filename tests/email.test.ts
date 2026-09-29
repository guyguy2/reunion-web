import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { configuredMailer, gmailRelayMailer, type Mailer } from '../server/email.ts'
import { emailNoteAlert } from '../server/notes.ts'
import { getPerson, insertPerson } from '../server/people.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-email-test-'))
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

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.5.1' },
    body: JSON.stringify({ passcode: 'class-pass' }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]
}

const exec = 'https://script.google.com/macros/s/ID/exec'
const answer = 'https://script.googleusercontent.com/macros/echo?user_content_key=1'
const message = { to: 'pal@example.com', subject: 'Hi', text: 'Body' }
const relayConfig = { ...config, gmailRelayUrl: exec, gmailRelaySecret: 'relay-secret' }

/** A Gmail relay whose fetch answers from `routes` and records every call. */
function relayWith(routes: Record<string, () => Response>) {
  const calls: { url: string; method: string; body?: string }[] = []
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body as string | undefined })
    const route = routes[String(url)]
    if (!route) throw new Error(`unexpected fetch to ${url}`)
    return route()
  }) as unknown as typeof fetch
  return { calls, mail: gmailRelayMailer(relayConfig, fakeFetch)! }
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })

afterEach(() => vi.restoreAllMocks())
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('sign-in link email', () => {
  it('drops the link when the email fails, says so in Hebrew, and lets the next request through', async () => {
    const outbox: Parameters<Mailer>[0][] = []
    let emailDown = true
    let lostText = ''
    const mailApp = createApp({ ...config, publicUrl: 'https://reunion.test' }, db, async (m) => {
      if (emailDown) {
        lostText = m.text
        throw new Error(`Gmail relay: could not send ${m.text}`)
      }
      outbox.push(m)
    })
    const member = await login(mailApp)
    const id = insertPerson(db, { name: 'Unlucky', email: 'unlucky@example.com', claimed_at: 'now' })
    const request = () => mailApp.request(`/api/people/${id}/signin-link`, { method: 'POST', headers: { Cookie: member } })
    const links = () => (db.prepare('SELECT COUNT(*) AS n FROM recovery_tokens WHERE person_id = ?').get(id) as { n: number }).n
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const failed = await request()
    expect(failed.status).toBe(400)
    expect(await failed.json()).toEqual({ error: 'לא הצלחנו לשלוח את המייל. נסו שוב בעוד רגע.' })
    expect(links()).toBe(0)
    // The server log keeps the mailer's reason, but not the link that was never delivered.
    const token = lostText.match(/signin\/(\S+)/)![1]
    const log = logged.mock.calls.flat().map(String).join('\n')
    expect(log).toContain('could not send')
    expect(log).not.toContain(token)

    // No cooldown after a failed send: asking again right away works.
    emailDown = false
    const retry = await request()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ sentTo: 'u***@example.com' })
    expect(outbox).toHaveLength(1)
    expect(links()).toBe(1)
  })
})

describe('Gmail relay redirects', () => {
  it('follows a redirect only to Google over https, and never sends the secret anywhere else', async () => {
    const away = [
      'http://evil.example/collect',
      'https://evil.example/collect',
      'http://script.google.com/macros/u/1/s/ID/exec',
      'http://script.googleusercontent.com/macros/echo?user_content_key=1',
    ]
    for (const location of away) {
      const { calls, mail } = relayWith({ [exec]: redirect(location), [location]: () => Response.json({ ok: true }) })
      const err = await mail(message).then(() => null, (e: Error) => e)
      expect(err, location).toBeInstanceOf(Error)
      expect(err!.message, location).not.toContain('relay-secret')
      expect(calls.map((c) => c.url), location).toEqual([exec])
    }
  })

  it('resolves a relative Location against the address that sent it', async () => {
    const moved = 'https://script.google.com/macros/u/1/s/ID/exec'
    const { calls, mail } = relayWith({
      [exec]: redirect('/macros/u/1/s/ID/exec'),
      [moved]: redirect(answer),
      [answer]: () => Response.json({ ok: true }),
    })
    await mail(message)
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', exec], ['POST', moved], ['GET', answer]])
    expect(JSON.parse(calls[1].body!)).toEqual({ secret: 'relay-secret', ...message })
  })
})

describe('email timeouts', () => {
  it('gives Resend and every relay request a minute before giving up', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const signals: unknown[] = []
    const fakeFetch = (async (url: string, init: RequestInit = {}) => {
      signals.push(init.signal)
      return url === exec ? Response.redirect(answer, 302) : Response.json({ ok: true })
    }) as unknown as typeof fetch

    await configuredMailer({ ...config, resendApiKey: 'key' }, fakeFetch)!(message)
    await gmailRelayMailer(relayConfig, fakeFetch)!(message)
    expect(signals).toHaveLength(3) // Resend POST, relay POST, relay answer GET
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
    expect(timeout.mock.calls).toEqual([[60_000], [60_000], [60_000]])
  })

  it('keeps the note alert slot when the email timed out (it may have gone out), and gives it back on other failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slotKept = async (mail: Mailer) => {
      const id = insertPerson(db, { name: 'Pen Pal', email: 'penpal@example.com' })
      await emailNoteAlert(db, getPerson(db, id)!, mail, 'https://reunion.test', 'Signature')
      return db.prepare('SELECT 1 FROM note_alerts WHERE person_id = ?').get(id) !== undefined
    }
    const failing = (err: unknown): Mailer => async () => {
      throw err
    }

    // A relay request that runs out of time rejects with fetch's TimeoutError.
    const timedOutFetch = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    expect(await slotKept(gmailRelayMailer(relayConfig, timedOutFetch)!)).toBe(true)
    expect(await slotKept(failing(new DOMException('This operation was aborted', 'AbortError')))).toBe(true)
    expect(await slotKept(failing(new Error('Gmail relay: forbidden')))).toBe(false)
  })
})
