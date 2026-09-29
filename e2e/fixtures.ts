import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { PASSCODES, startServer, type RunningServer } from './server.ts'

export { expect, PASSCODES }

interface WorkerFixtures {
  /** One running server per spec file, keyed by the file's path. */
  servers: Map<string, RunningServer>
}

interface TestFixtures {
  server: RunningServer
  /** A test that expects an uncaught page error sets this to true. */
  allowPageErrors: boolean
  /** Uncaught page errors seen so far, in every context of this test. */
  pageErrors: string[]
  /**
   * Opens a new page in a NEW browser context (a second person, a fresh browser) with the same settings as the
   * test's own: baseURL, locale, timezone, viewport, its own x-real-ip, external requests blocked, and its page
   * errors counted. Specs must use this instead of browser.newContext(), which skips all of that.
   * Every context it opened is closed when the test ends.
   */
  anotherUser: () => Promise<Page>
  blockExternalRequests: void
  failOnPageErrors: void
}

let testCount = 0

// The server's limiters are per client address, so every context presents its own.
function nextClientIp(workerIndex: number): string {
  const n = testCount++
  return `10.${workerIndex % 256}.${(n >> 8) % 256}.${n % 256}`
}

// page.request and context.request are not routed, so specs pass them only relative URLs (they resolve to the server).
function blockExternal(context: BrowserContext, origin: string) {
  return Promise.all([
    context.route('**/*', (route) => {
      const { protocol, origin: target } = new URL(route.request().url())
      if (protocol !== 'http:' && protocol !== 'https:') return route.fallback()
      return target === origin ? route.fallback() : route.abort()
    }),
    // context.route does not see WebSockets.
    context.routeWebSocket(/.*/, (ws) => {
      const url = new URL(ws.url())
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
      if (url.origin === origin) ws.connectToServer()
      else ws.close()
    }),
  ])
}

function collectPageErrors(context: BrowserContext, errors: string[]) {
  const watch = (page: Page) => page.on('pageerror', (err) => errors.push(err.stack ?? String(err)))
  context.pages().forEach(watch)
  context.on('page', watch)
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  servers: [
    async ({}, use) => {
      const servers = new Map<string, RunningServer>()
      await use(servers)
      await Promise.all([...servers.values()].map((s) => s.stop()))
    },
    { scope: 'worker' },
  ],

  // Tests of one file share a server (and its data) in order; moving on to the next file stops the previous server.
  // A failed test restarts the worker, so the rest of that file runs on a fresh server with fresh demo data.
  server: async ({ servers }, use, testInfo) => {
    let server = servers.get(testInfo.file)
    if (!server) {
      await Promise.all([...servers.values()].map((s) => s.stop()))
      servers.clear()
      server = await startServer()
      servers.set(testInfo.file, server)
    }
    await use(server)
  },

  baseURL: async ({ server }, use) => use(server.url),

  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use({ 'x-real-ip': nextClientIp(testInfo.workerIndex) })
  },

  allowPageErrors: [false, { option: true }],

  pageErrors: async ({}, use) => use([]),

  anotherUser: async ({ browser, server, pageErrors, viewport, locale, timezoneId, isMobile, hasTouch, deviceScaleFactor, userAgent }, use, testInfo) => {
    const contexts: BrowserContext[] = []
    await use(async () => {
      const context = await browser.newContext({
        baseURL: server.url,
        locale,
        timezoneId,
        viewport,
        isMobile,
        hasTouch,
        deviceScaleFactor,
        userAgent,
        extraHTTPHeaders: { 'x-real-ip': nextClientIp(testInfo.workerIndex) },
      })
      contexts.push(context)
      await blockExternal(context, server.url)
      collectPageErrors(context, pageErrors)
      return context.newPage()
    })
    await Promise.all(contexts.map((c) => c.close()))
  },

  blockExternalRequests: [
    async ({ context, server }, use) => {
      await blockExternal(context, server.url)
      await use()
    },
    { auto: true },
  ],

  failOnPageErrors: [
    async ({ context, pageErrors, allowPageErrors }, use) => {
      collectPageErrors(context, pageErrors)
      await use()
      if (!allowPageErrors) expect(pageErrors, 'uncaught page errors').toEqual([])
    },
    { auto: true },
  ],
})

/** Logs this browser context in through the API, so the session cookie lands in it. Does not navigate. */
export async function login(page: Page, role: 'member' | 'admin'): Promise<void> {
  const res = await page.request.post('/api/login', { data: { passcode: PASSCODES[role] } })
  expect(res.ok(), `login as ${role}`).toBe(true)
}
