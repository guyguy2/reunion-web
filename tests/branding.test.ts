import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import Gate from '../web/src/components/Gate.tsx'
import Branding, { hasUpload } from '../web/src/routes/Branding.tsx'

// The placeholders are read from the built client, where the build copies web/public. Here web/public stands in for it.
const WEB_PUBLIC = fileURLToPath(new URL('../web/public', import.meta.url))
const NAMES = ['emblem.png', 'postcard.webp', 'favicon.png', 'apple-touch-icon.png']
const TYPES: Record<string, string> = { png: 'image/png', webp: 'image/webp' }
const MB = 1024 * 1024

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-branding-test-'))
const config: Config = {
  dataDir,
  classPasscode: 'class-pass',
  adminPasscode: 'admin-pass',
  sessionSecret: 'test-secret',
  port: 0,
  webDir: WEB_PUBLIC,
  secureCookies: false,
  publicUrl: 'https://example.test',
}
const db = openDb(dataDir)
const app = createApp(config, db)

async function login(passcode: string, ip: string): Promise<string> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ passcode }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]
}

const placeholder = (name: string) => fs.readFileSync(path.join(WEB_PUBLIC, 'branding', name))
const override = (name: string) => path.join(dataDir, 'branding', name)
const get = (name: string) => app.request(`/branding/${name}`)
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer())

function upload(cookie: string, name: string, file: File) {
  const form = new FormData()
  form.set('file', file)
  return app.request(`/api/admin/branding/${name}`, { method: 'POST', headers: { Cookie: cookie }, body: form })
}

const remove = (cookie: string, name: string) => app.request(`/api/admin/branding/${name}`, { method: 'DELETE', headers: { Cookie: cookie } })

/** Random pixels barely compress, so the file comes out well over the 64 KB that ordinary API requests may send. */
async function noisyImage(format: 'png' | 'webp', width = 300, height = 300) {
  const pixels = crypto.randomBytes(width * height * 3)
  const image = await sharp(pixels, { raw: { width, height, channels: 3 } })[format]().toBuffer()
  return new File([new Uint8Array(image)], `picture.${format}`, { type: TYPES[format] })
}

let member: string
let admin: string

beforeAll(async () => {
  member = await login('class-pass', '10.61.0.1')
  admin = await login('admin-pass', '10.61.0.2')
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('branding pictures', () => {
  it('serves the placeholder for each name without a session, cached for an hour', async () => {
    for (const name of NAMES) {
      const res = await get(name)
      expect(res.status, name).toBe(200)
      expect(res.headers.get('content-type'), name).toBe(TYPES[path.extname(name).slice(1)])
      expect(res.headers.get('cache-control'), name).toBe('public, max-age=3600')
      expect(res.headers.get('x-branding-source'), name).toBe('placeholder')
      expect((await bytes(res)).equals(placeholder(name)), name).toBe(true)
    }
  })

  it("serves an organizer's upload instead, converted to the format its name says", async () => {
    const postcard = await noisyImage('png')
    expect(postcard.size).toBeGreaterThan(64 * 1024)
    const uploaded = await upload(admin, 'postcard.webp', postcard)
    expect(uploaded.status).toBe(200)
    expect(await uploaded.json()).toEqual({ ok: true })
    expect(fs.existsSync(override('postcard.webp'))).toBe(true)

    const served = await get('postcard.webp')
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/webp')
    expect(served.headers.get('x-branding-source')).toBe('upload')
    const body = await bytes(served)
    expect(body.equals(placeholder('postcard.webp'))).toBe(false)
    expect(await sharp(body).metadata()).toMatchObject({ format: 'webp', width: 300, height: 300 })

    expect((await upload(admin, 'emblem.png', await noisyImage('webp', 140, 128))).status).toBe(200)
    const emblem = await get('emblem.png')
    expect(emblem.headers.get('content-type')).toBe('image/png')
    expect(await sharp(await bytes(emblem)).metadata()).toMatchObject({ format: 'png', width: 140, height: 128 })
  })

  it('removes an upload, and the placeholder comes back', async () => {
    expect((await upload(admin, 'favicon.png', await noisyImage('png', 64, 64))).status).toBe(200)
    expect((await bytes(await get('favicon.png'))).equals(placeholder('favicon.png'))).toBe(false)

    const removed = await remove(admin, 'favicon.png')
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true })
    expect(fs.existsSync(override('favicon.png'))).toBe(false)
    const restored = await get('favicon.png')
    expect(restored.headers.get('x-branding-source')).toBe('placeholder')
    expect((await bytes(restored)).equals(placeholder('favicon.png'))).toBe(true)

    // Removing again, with nothing left to remove, is not an error.
    expect((await remove(admin, 'favicon.png')).status).toBe(200)
  })

  it('falls back to the placeholder when a folder is where the upload would be, or a file where the uploads folder would be', async () => {
    fs.mkdirSync(override('favicon.png'), { recursive: true })
    try {
      const res = await get('favicon.png')
      expect(res.status).toBe(200)
      expect(res.headers.get('x-branding-source')).toBe('placeholder')
      expect((await bytes(res)).equals(placeholder('favicon.png'))).toBe(true)
    } finally {
      fs.rmdirSync(override('favicon.png'))
    }

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-branding-test-'))
    try {
      fs.writeFileSync(path.join(otherDir, 'branding'), 'a file, not a folder')
      const res = await createApp({ ...config, dataDir: otherDir }, db).request('/branding/emblem.png')
      expect(res.status).toBe(200)
      expect((await bytes(res)).equals(placeholder('emblem.png'))).toBe(true)
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('answers a classmate with 403, and changes nothing', async () => {
    // Small enough to get past the body limit a classmate gets on organizer paths, so the refusal comes from the role.
    const refused = await upload(member, 'apple-touch-icon.png', await noisyImage('png', 40, 40))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'למארגנים בלבד' })
    expect(fs.existsSync(override('apple-touch-icon.png'))).toBe(false)

    expect((await upload(admin, 'apple-touch-icon.png', await noisyImage('png', 180, 180))).status).toBe(200)
    const notRemoved = await remove(member, 'apple-touch-icon.png')
    expect(notRemoved.status).toBe(403)
    expect(await notRemoved.json()).toEqual({ error: 'למארגנים בלבד' })
    expect(fs.existsSync(override('apple-touch-icon.png'))).toBe(true)
  })

  it('answers 404 for any other name', async () => {
    for (const url of ['/branding/logo.png', '/branding/emblem.webp', '/branding/emblem.png.tmp', '/branding/emblem.png/x']) {
      expect((await app.request(url)).status, url).toBe(404)
    }
    const png = await noisyImage('png', 40, 40)
    const uploaded = await upload(admin, 'logo.png', png)
    expect(uploaded.status).toBe(404)
    expect(await uploaded.json()).toEqual({ error: 'Not found' })
    expect(fs.existsSync(override('logo.png'))).toBe(false)
    const removed = await remove(admin, 'logo.png')
    expect(removed.status).toBe(404)
    expect(await removed.json()).toEqual({ error: 'Not found' })
  })

  it('refuses a name that tries to leave the folder', async () => {
    // web/public/branding/../../index.html is the client's index.html, and a file sits next to the data dir's branding folder.
    fs.writeFileSync(path.join(dataDir, 'secret.png'), 'not for visitors')
    for (const name of ['..%2F..%2Findex.html', '%2E%2E%2F..%2Findex.html', '..%2Fsecret.png', '..%5Csecret.png']) {
      expect((await get(name)).status, name).toBe(404)
    }
    const png = await noisyImage('png', 40, 40)
    for (const name of ['..%2Femblem.png', '..%2F..%2Femblem.png', '%2E%2E%2Fsecret.png']) {
      const res = await upload(admin, name, png)
      expect(res.status, name).toBe(404)
      expect((await remove(admin, name)).status, name).toBe(404)
    }
    expect(fs.existsSync(path.join(dataDir, 'emblem.png'))).toBe(false)
    expect(fs.readFileSync(path.join(dataDir, 'secret.png'), 'utf8')).toBe('not for visitors')
  })

  it('refuses a file that is not an image, or is too big, and keeps the placeholder', async () => {
    const text = await upload(admin, 'favicon.png', new File(['just some text'], 'notes.txt', { type: 'text/plain' }))
    expect(text.status).toBe(400)
    expect(await text.json()).toEqual({ error: 'הקובץ חייב להיות תמונה' })

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fake = await upload(admin, 'favicon.png', new File(['not really a png'], 'fake.png', { type: 'image/png' }))
      expect(fake.status).toBe(400)
      expect(await fake.json()).toEqual({ error: 'הקובץ אינו תמונה תקינה' })
      // The image library's own message goes to the log, not to the organizer.
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }

    const big = await upload(admin, 'favicon.png', new File([new Uint8Array(5 * MB + 1)], 'big.png', { type: 'image/png' }))
    expect(big.status).toBe(400)
    expect(await big.json()).toEqual({ error: 'התמונה גדולה מדי (עד 5MB)' })

    const huge = await upload(admin, 'favicon.png', new File([new Uint8Array(6 * MB + 1)], 'huge.png', { type: 'image/png' }))
    expect(huge.status).toBe(413)
    expect(await huge.json()).toEqual({ error: 'הקובץ או הבקשה גדולים מדי' })

    expect(fs.existsSync(override('favicon.png'))).toBe(false)
    expect((await bytes(await get('favicon.png'))).equals(placeholder('favicon.png'))).toBe(true)
  })
})

describe('the client asks for the branding pictures by name', () => {
  it('ships only the placeholders in web/public', () => {
    // Dotfiles such as .DS_Store are the local machine's, not part of the repo.
    const listing = (dir: string) => fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
    expect(listing(WEB_PUBLIC)).toEqual(['branding'])
    expect(listing(path.join(WEB_PUBLIC, 'branding')).sort()).toEqual([...NAMES].sort())
  })

  it('points the page icons at /branding', () => {
    const html = fs.readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')
    expect(html).toContain('<link rel="icon" href="/branding/favicon.png" type="image/png" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/branding/apple-touch-icon.png" />')
  })

  it('shows the postcard from /branding on the passcode screen', () => {
    const html = renderToStaticMarkup(createElement(Gate, { onEnter: () => {} }))
    expect(html.match(/src="\/branding\/postcard\.webp"/g)).toHaveLength(2)
  })

  it("gives the organizers each picture with a replace and a remove control", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Branding)))
    for (const name of NAMES) expect(html, name).toMatch(new RegExp(`<img src="/branding/${name.replace('.', '\\.')}\\?v=\\d+"`))
    expect(html.match(/type="file"/g)).toHaveLength(NAMES.length)
    // Until the page has asked the server which pictures are uploads, there is nothing it knows it can remove.
    expect(html.match(/<button[^>]* disabled=""[^>]*>הסרה</g)).toHaveLength(NAMES.length)
  })

  it('tells an upload from a placeholder by asking the server', async () => {
    const server = async (url: string, init: RequestInit) => app.request(url, init)
    expect((await upload(admin, 'emblem.png', await noisyImage('png', 40, 40))).status).toBe(200)
    expect((await remove(admin, 'favicon.png')).status).toBe(200)
    expect(await hasUpload('emblem.png', 1, server)).toBe(true)
    expect(await hasUpload('favicon.png', 1, server)).toBe(false)

    const asked: [string, RequestInit][] = []
    await hasUpload('postcard.webp', 42, async (url, init) => (asked.push([url, init]), new Response(null)))
    expect(asked).toEqual([['/branding/postcard.webp?v=42', { method: 'HEAD' }]])

    // When the check itself fails, removing stays possible: with nothing to remove it does no harm.
    expect(await hasUpload('favicon.png', 1, () => Promise.reject(new TypeError('Failed to fetch')))).toBe(true)
  })
})
