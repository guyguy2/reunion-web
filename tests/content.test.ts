import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb, type SceneRow } from '../server/db.ts'
import { insertPerson, parsePersonInput } from '../server/people.ts'
import { albumPhotos, albumVideos } from '../server/album.ts'
import { rebuildWall } from '../server/scenes.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-content-test-'))
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
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.5.1' },
    body: JSON.stringify({ passcode }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]
}

let admin: string

beforeAll(async () => {
  admin = await login('admin-pass')
})

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('instagram handles', () => {
  const parse = (instagram: string) => parsePersonInput({ instagram }, { admin: false }).instagram

  it('keeps only the handle from a link without a scheme', () => {
    expect(parse('instagram.com/johndoe')).toBe('johndoe')
    expect(parse('www.instagram.com/johndoe/')).toBe('johndoe')
  })

  it('drops the query and fragment of a share link', () => {
    expect(parse('https://www.instagram.com/johndoe?igsh=MTIz')).toBe('johndoe')
    expect(parse('https://instagram.com/john.doe_1/?igsh=MTIz#top')).toBe('john.doe_1')
  })

  it('accepts a plain handle and an @handle', () => {
    expect(parse('johndoe')).toBe('johndoe')
    expect(parse('@john.doe_1')).toBe('john.doe_1')
  })

  it('rejects anything that is not a handle', () => {
    for (const input of ['john doe', 'https://www.instagram.com/', 'a'.repeat(31), 'https://example.com/johndoe']) {
      expect(() => parse(input), input).toThrow('שם המשתמש באינסטגרם לא תקין')
    }
  })
})

describe('flag columns', () => {
  const parse = (body: Record<string, unknown>) => parsePersonInput(body, { admin: true })

  it('reads "0" and "no" as off', () => {
    expect(parse({ in_memoriam: '0', show_email: 'no' })).toEqual({ in_memoriam: 0, show_email: 0 })
  })

  it('reads yes/no words in English and Hebrew, trimmed and in any case', () => {
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'Yes', 'כן']) expect(parse({ show_email: on }).show_email, on).toBe(1)
    for (const off of ['0', 'false', 'No', 'לא', '', '  ']) expect(parse({ show_email: off }).show_email, off).toBe(0)
  })

  it('still takes booleans and numbers from JSON bodies', () => {
    expect(parse({ showEmail: true, showPhone: false, inMemoriam: 1, showX: 0 })).toEqual({ show_email: 1, show_phone: 0, in_memoriam: 1, show_x: 0 })
  })

  it('rejects a flag value it cannot read', () => {
    expect(() => parse({ show_email: 'maybe' })).toThrow('ערך לא תקין (show_email)')
  })

  it('imports in_memoriam 0 and show_email no from a CSV as off', async () => {
    const csv = 'Name,In Memoriam,Show Email\nFlag Off,0,no\nFlag On,כן,yes\n'
    const res = await app.request('/api/admin/import-csv', { method: 'POST', headers: { Cookie: admin }, body: csv })
    expect(await res.json()).toEqual({ added: 2, skipped: [] })
    const rows = db.prepare(`SELECT name, in_memoriam, show_email FROM people WHERE name LIKE 'Flag %' ORDER BY name`).all()
    expect(rows).toEqual([
      { name: 'Flag Off', in_memoriam: 0, show_email: 0 },
      { name: 'Flag On', in_memoriam: 1, show_email: 1 },
    ])
  })
})

describe('album fetch', () => {
  const page = '["https://lh3.googleusercontent.com/pw/pic1",800,600]'

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('waits a minute before retrying a failed refresh, and keeps serving the last photos', async () => {
    const url = 'https://photos.app.goo.gl/backoff-test'
    const fetch = vi.fn(async () => new Response(page))
    vi.stubGlobal('fetch', fetch)
    expect(await albumPhotos(url)).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 31 * 60_000)
    fetch.mockImplementation(async () => {
      throw new Error('offline')
    })
    expect(await albumPhotos(url)).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await albumPhotos(url)).toHaveLength(1)
    expect(await albumVideos(url)).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)

    vi.setSystemTime(Date.now() + 61_000)
    expect(await albumPhotos(url)).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('shares one fetch between callers that arrive while it is running', async () => {
    const url = 'https://photos.app.goo.gl/parallel-test'
    let respond!: (res: Response) => void
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)))
    vi.stubGlobal('fetch', fetch)
    const photos = albumPhotos(url)
    const videos = albumVideos(url)
    expect(fetch).toHaveBeenCalledTimes(1)
    respond(new Response(page))
    expect(await photos).toHaveLength(1)
    expect(await videos).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('wall rebuild', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  // Without a newer scene the new wall reuses the old wall's row id; with one it gets a fresh id.
  it.each([
    ['the wall is the newest scene', false],
    ['a class photo was added after the wall', true],
  ])('leaves exactly one wall, with its tiles, when two rebuilds overlap and %s', async (_label, groupAfterWall) => {
    const wallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-content-wall-'))
    dirs.push(wallDir)
    const wallDb = openDb(wallDir)
    for (const name of ['Ada Lane', 'Ben Oz', 'Cy Park']) insertPerson(wallDb, { name })
    await rebuildWall(wallDb, wallDir)
    if (groupAfterWall) {
      wallDb.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort) VALUES ('prom', 'Prom', 'group', 10, 10, 'scenes/prom', 1)`).run()
    }
    await Promise.all([rebuildWall(wallDb, wallDir), rebuildWall(wallDb, wallDir)])

    const walls = wallDb.prepare(`SELECT * FROM scenes WHERE kind = 'mosaic'`).all() as unknown as SceneRow[]
    expect(walls).toHaveLength(1)
    expect(fs.existsSync(path.join(wallDir, walls[0].tiles_path, 'scene.dzi'))).toBe(true)
    const wallDirs = fs.readdirSync(path.join(wallDir, 'scenes')).filter((name) => name.startsWith('wall-'))
    expect(wallDirs).toEqual([path.basename(walls[0].tiles_path)])
    const { n } = wallDb.prepare('SELECT COUNT(*) AS n FROM tags WHERE scene_id = ?').get(walls[0].id) as { n: number }
    expect(n).toBe(3)
    wallDb.close()
  })
})
