import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.ts'
import type { Config } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import type { Scene, Tag } from '../web/src/api.ts'
import { BACKUP_DESCRIPTION } from '../web/src/adminBackup.ts'
import { finished, isBusy, started, type Busy } from '../web/src/adminBusy.ts'
import { isTypingTarget } from '../web/src/adminKeys.ts'
import { oneAtATime } from '../web/src/adminOnce.ts'
import { nextLive, previousLive } from '../web/src/adminQueue.ts'
import { fetchImageBlob } from '../web/src/fetchImage.ts'
import { landOnPerson, yearbookPath } from '../web/src/personLink.ts'
import { RELOAD_FAILED, reloadFailedText, saveThenReload } from '../web/src/taggerSave.ts'

// The tests run without a DOM, so this stands in for an element: `closest` walks up the parents like the browser's,
// matching tag names, [attribute] and [attribute="value"] selectors and :not(), and like the browser's it fails when
// called without its element.
interface FakeElement {
  tagName: string
  attributes: Record<string, string>
  parentElement: FakeElement | null
  closest(selector: string): FakeElement | null
}

function element(tagName: string, attributes: Record<string, string> = {}, parentElement: FakeElement | null = null): FakeElement {
  return {
    tagName: tagName.toUpperCase(),
    attributes,
    parentElement,
    closest(this: FakeElement | undefined, selector: string) {
      if (!this) throw new TypeError('Illegal invocation')
      const parts = selector.split(',').map((part) => part.trim())
      for (let node: FakeElement | null = this; node; node = node.parentElement) {
        const current = node
        if (parts.some((part) => matches(current, part))) return current
      }
      return null
    },
  }
}

function matches(node: FakeElement, part: string): boolean {
  const not = /^(.+):not\((.+)\)$/.exec(part)
  if (not) return matches(node, not[1]) && !matches(node, not[2])
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)
  if (attribute) return attribute[1] in node.attributes && (attribute[2] === undefined || node.attributes[attribute[1]] === attribute[2])
  return node.tagName === part.toUpperCase()
}

const typing = (target: FakeElement | object | null) => isTypingTarget(target as EventTarget | null)

describe('roster keyboard shortcuts', () => {
  it('stay out of text fields, text areas and dropdowns', () => {
    expect(typing(element('input'))).toBe(true)
    expect(typing(element('textarea'))).toBe(true)
    expect(typing(element('select'))).toBe(true)
  })

  it('stay out of editable text, including the spans inside it', () => {
    const editor = element('div', { contenteditable: 'true' })
    expect(typing(editor)).toBe(true)
    expect(typing(element('span', {}, element('span', {}, editor)))).toBe(true)
  })

  it('still work on text marked as not editable', () => {
    expect(typing(element('div', { contenteditable: 'false' }))).toBe(false)
    expect(typing(element('span', {}, element('div', { contenteditable: 'false' })))).toBe(false)
  })

  it('still work on buttons, plain text and the page itself', () => {
    expect(typing(element('button'))).toBe(false)
    expect(typing(element('span', {}, element('span', {}, element('div'))))).toBe(false)
    expect(typing(element('body'))).toBe(false)
  })

  it('still work when there is no element to check', () => {
    expect(typing(null)).toBe(false)
    // The window receives key presses too, and it has no `closest`.
    expect(typing({ addEventListener() {} })).toBe(false)
  })
})

describe('roster review queue', () => {
  // People 2 and 4 were merged into someone else or hidden as staff after the queue was frozen.
  const queue = [1, 2, 3, 4, 5]
  const exists = (id: number) => id !== 2 && id !== 4

  it('stays on a person who is still there', () => {
    expect(nextLive(queue, 0, exists)).toBe(0)
    expect(nextLive(queue, 2, exists)).toBe(2)
  })

  it('steps over people who are gone', () => {
    expect(nextLive(queue, 1, exists)).toBe(2)
    expect(nextLive(queue, 3, exists)).toBe(4)
  })

  it('runs off the end when nobody is left', () => {
    expect(nextLive(queue, 5, exists)).toBe(5)
    expect(nextLive([1, 2], 0, () => false)).toBe(2)
  })

  it('goes back past people who are gone instead of landing on nobody', () => {
    expect(previousLive(queue, 2, exists)).toBe(0)
    expect(previousLive(queue, 4, exists)).toBe(2)
  })

  it('has nowhere to go back to at the start', () => {
    expect(previousLive(queue, 0, exists)).toBe(-1)
    expect(previousLive([2, 3], 1, (id) => id === 3)).toBe(-1)
  })

  it('goes back from the end of the queue to the last person still there', () => {
    expect(previousLive(queue, queue.length, (id) => id !== 5)).toBe(3)
  })

  it('moves on after hiding the current person, without skipping the next one', () => {
    // Person 3 is hidden as staff while on screen; advancing from their place shows person 5, the next still there.
    const afterStaff = (id: number) => exists(id) && id !== 3
    const at = 2
    expect(nextLive(queue, at + 1, afterStaff)).toBe(4)
    expect(queue[nextLive(queue, at, afterStaff)]).toBe(5)
  })
})

describe('one roster action at a time', () => {
  it('ignores a second call while the first is still running', async () => {
    let finish = () => {}
    const busy = vi.fn()
    const once = oneAtATime(busy)
    const first = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const second = vi.fn(async () => {})

    const running = once(first)
    await once(second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(busy).toHaveBeenLastCalledWith(true)

    finish()
    await running
    expect(busy).toHaveBeenLastCalledWith(false)
    await once(second)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('lets the next call run after one fails', async () => {
    const busy = vi.fn()
    const once = oneAtATime(busy)
    await expect(once(() => Promise.reject(new Error('network down')))).rejects.toThrow('network down')
    expect(busy).toHaveBeenLastCalledWith(false)

    const next = vi.fn(async () => {})
    await once(next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('admin page busy flags', () => {
  it('keeps the CSV import busy while adding a person starts and finishes', () => {
    let busy: Busy = {}
    busy = started(busy, 'csv')
    busy = started(busy, 'person')
    busy = finished(busy, 'person')
    expect(isBusy(busy, 'csv')).toBe(true)
    expect(isBusy(busy, 'person')).toBe(false)

    busy = finished(busy, 'csv')
    expect(isBusy(busy, 'csv')).toBe(false)
  })

  it('stays busy until both runs of the same action are done', () => {
    let busy: Busy = {}
    busy = started(busy, 'delete')
    busy = started(busy, 'delete')
    busy = finished(busy, 'delete')
    expect(isBusy(busy, 'delete')).toBe(true)
    busy = finished(busy, 'delete')
    expect(isBusy(busy, 'delete')).toBe(false)
  })

  it('returns new state instead of changing the old one, so React sees the change', () => {
    const before: Busy = {}
    const after = started(before, 'wall')
    expect(before).toEqual({})
    expect(isBusy(after, 'wall')).toBe(true)
    expect(finished(after, 'wall')).toEqual({})
    expect(isBusy(after, 'wall')).toBe(true)
  })

  it('knows nothing is busy at the start', () => {
    expect(isBusy({}, 'scene')).toBe(false)
  })
})

describe('backup description', () => {
  // Every part of GET /api/admin/export (server/admin.ts), by its key in the file.
  const included = {
    people: 'הפרופילים',
    person_photos: 'רשימת התמונות האישיות',
    scenes: 'התמונות הקבוצתיות',
    tags: 'תיוגי הפנים',
    quotes: 'הציטוטים',
    quote_comments: 'התגובות',
    quote_reactions: 'תגובות האימוג׳י',
    tapes: 'הקלטות',
    videos: 'הסרטונים',
    credits: 'רשימת התודות',
  }

  it('names everything the export holds', () => {
    for (const phrase of Object.values(included)) expect(BACKUP_DESCRIPTION).toContain(phrase)
  })

  it('says what stays out of it', () => {
    for (const phrase of ['בלי קבצי התמונות', 'קודים אישיים', 'קישורי עריכה', 'בלי פתקים', 'בלי משוב']) expect(BACKUP_DESCRIPTION).toContain(phrase)
  })

  // A new part in the export fails here until it is named above and in the description.
  describe('against the real export', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-backup-text-'))
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
    const app = createApp(config, openDb(dataDir))

    afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

    it('lists exactly the parts GET /api/admin/export returns', async () => {
      const login = await app.request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.0.1' },
        body: JSON.stringify({ passcode: 'admin-pass' }),
      })
      expect(login.status).toBe(200)
      const admin = login.headers.get('set-cookie')!.split(';')[0]

      const res = await app.request('/api/admin/export', { headers: { Cookie: admin } })
      expect(res.status).toBe(200)
      const parts = Object.keys((await res.json()) as Record<string, unknown>).filter((key) => key !== 'exportedAt' && key !== 'schemaVersion')
      expect(parts.sort()).toEqual(Object.keys(included).sort())
    })
  })
})

describe('tagger save and reload', () => {
  it('reports the saved value when the save and the reload both work', async () => {
    const reload = vi.fn(async () => {})
    expect(await saveThenReload(async () => 3, reload)).toEqual({ status: 'done', value: 3 })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("passes on the server's reason when the save fails, and does not reload", async () => {
    const reload = vi.fn(async () => {})
    const result = await saveThenReload(() => Promise.reject(new Error('המסגרת לא נמצאה')), reload)
    expect(result).toEqual({ status: 'not-saved', error: 'המסגרת לא נמצאה' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps the save when only the reload fails, without the browser error', async () => {
    const result = await saveThenReload(async () => 5, () => Promise.reject(new TypeError('Failed to fetch')))
    expect(result).toEqual({ status: 'not-reloaded', value: 5 })
    expect(JSON.stringify(result)).not.toContain('Failed to fetch')
  })

  it('explains a failed reload in Hebrew, saying the change was kept', () => {
    expect(RELOAD_FAILED).toMatch(/[\u0590-\u05FF]/)
    expect(RELOAD_FAILED).toContain('נשמר')
    expect(reloadFailedText(true)).toBe(RELOAD_FAILED)
  })

  it('does not claim a change was kept when nothing was saved (auto-detect found no faces)', () => {
    const text = reloadFailedText(false)
    expect(text).toMatch(/[\u0590-\u05FF]/)
    expect(text).not.toContain('נשמר')
  })
})

describe('face detection image download', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands back the picture when the download works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['jpeg bytes'], { type: 'image/jpeg' }))))
    const blob = await fetchImageBlob('/media/scenes/1/scene.jpg')
    expect(blob.type).toBe('image/jpeg')
    expect(await blob.text()).toBe('jpeg bytes')
  })

  it('fails in Hebrew when the server answers with an error, instead of decoding the error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })))
    await expect(fetchImageBlob('/media/scenes/1/scene.jpg')).rejects.toThrow(/[\u0590-\u05FF]/)
  })
})

describe('deep link to a person', () => {
  const tag = (id: number, sceneId: number, personId: number | null): Tag => ({ id, sceneId, personId, x: 0, y: 0, w: 10, h: 10, caption: null, classLabel: null, staff: false })
  const scene = (id: number, tags: Tag[]): Scene => ({ id, slug: `s${id}`, title: `S${id}`, kind: 'group', year: null, width: 100, height: 100, dzi: '', tags })
  const scenes = [scene(1, [tag(11, 1, 7)]), scene(2, [tag(21, 2, 8), tag(22, 2, 7)])]

  it('flies to the face when the scene on screen shows the person', () => {
    expect(landOnPerson(8, scenes[1], scenes)).toEqual({ focus: 21 })
  })

  it('moves to a scene that shows the person, replacing the link so back does not bounce', () => {
    expect(landOnPerson(8, scenes[0], scenes)).toEqual({ redirect: ['/p/8?s=s2', { replace: true }] })
  })

  it('stays put when no scene shows the person', () => {
    expect(landOnPerson(9, scenes[0], scenes)).toBeNull()
  })

  it('builds the yearbook address for a person or nobody, with or without a scene', () => {
    expect(yearbookPath(8, 's2')).toBe('/p/8?s=s2')
    expect(yearbookPath(null, 's1')).toBe('/?s=s1')
    expect(yearbookPath(8, undefined)).toBe('/p/8')
    expect(yearbookPath(undefined, undefined)).toBe('/')
  })
})
