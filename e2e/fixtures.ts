import { test as base, expect, type Page } from '@playwright/test'
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
  blockExternalRequests: void
  failOnPageErrors: void
}

let testCount = 0

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

  // The server's limiters are per client address, so every test presents its own.
  extraHTTPHeaders: async ({}, use, testInfo) => {
    const n = testCount++
    await use({ 'x-real-ip': `10.${testInfo.workerIndex % 256}.${(n >> 8) % 256}.${n % 256}` })
  },

  allowPageErrors: [false, { option: true }],

  blockExternalRequests: [
    async ({ context, server }, use) => {
      await context.route('**/*', (route) => {
        const { protocol, origin } = new URL(route.request().url())
        if (protocol !== 'http:' && protocol !== 'https:') return route.fallback()
        return origin === server.url ? route.fallback() : route.abort()
      })
      await use()
    },
    { auto: true },
  ],

  failOnPageErrors: [
    async ({ context, allowPageErrors }, use) => {
      const errors: string[] = []
      const watch = (page: Page) => page.on('pageerror', (err) => errors.push(err.stack ?? String(err)))
      context.pages().forEach(watch)
      context.on('page', watch)
      await use()
      if (!allowPageErrors) expect(errors, 'uncaught page errors').toEqual([])
    },
    { auto: true },
  ],
})

/** Logs this browser context in through the API, so the session cookie lands in it. Does not navigate. */
export async function login(page: Page, role: 'member' | 'admin'): Promise<void> {
  const res = await page.request.post('/api/login', { data: { passcode: PASSCODES[role] } })
  expect(res.ok(), `login as ${role}`).toBe(true)
}
