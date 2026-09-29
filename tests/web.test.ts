import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, editToken, matchesPerson, type Person, type Scene, type Tape } from '../web/src/api.ts'
import { deckTape, loadSpotifyApi, loadYouTubeApi, spotifyEndWatcher } from '../web/src/components/Cassette.tsx'
import ContactLinks from '../web/src/components/ContactLinks.tsx'
import FriendFilters, { classMenuValue, classValue, pickClass } from '../web/src/components/FriendFilters.tsx'
import LoadFailed from '../web/src/components/LoadFailed.tsx'
import { daysLeft, rsvpShortcut } from '../web/src/components/Rsvp.tsx'
import { ignoreGone, NoteCard, noteAction } from '../web/src/components/Notes.tsx'
import { ClaimNudge } from '../web/src/components/PersonPanel.tsx'
import { faceDirection, firstFace, focusVisible, neighborFace, SceneOpenFailed } from '../web/src/components/SceneViewerParts.tsx'
import { LAYER, pushEscape } from '../web/src/useEscape.ts'
import { Credits } from '../web/src/routes/EventPage.tsx'
import { shouldResetDraft } from '../web/src/routes/Me.tsx'
import { dealIntoColumns } from '../web/src/routes/Memories.tsx'
import { firstName, greeting } from '../web/src/components/Welcome.tsx'
import { daysUntil } from '../web/src/days.ts'
import { nameKey, possibleDuplicates } from '../web/src/roster.ts'
import { adoptEditToken, attempt, checkEditToken } from '../web/src/store.tsx'
import { buildShelf, canSkip, nextTape, pickTape, spotifyUri, tapeFinished } from '../web/src/tapes.ts'
import { embedUrl, isTallEmbed, streamUrl, thumbnailUrl } from '../web/src/videos.ts'
import { compareClass, filterOptions, filterPeople, isFiltering, NO_FILTERS, tilePhoto, unknownFaces, type Filters } from '../web/src/yearbook.ts'

type Links = { email: string | null; instagram: string | null; linkedin: string | null; facebook?: string | null; website?: string | null; phone?: string | null; x?: string | null }
const render = (person: Links) => renderToStaticMarkup(createElement(ContactLinks, { person: { facebook: null, website: null, phone: null, x: null, ...person } }))

describe('contact links', () => {
  it('shows the email address itself, not just an "email" label', () => {
    const html = render({ email: 'guy@example.com', instagram: null, linkedin: null })
    expect(html).toContain('>guy@example.com</a>')
    expect(html).toContain('href="mailto:guy@example.com"')
  })

  it('shows the Instagram handle and renders nothing when there is no contact info', () => {
    expect(render({ email: null, instagram: 'jenny_c', linkedin: null })).toContain('@jenny_c')
    expect(render({ email: null, instagram: null, linkedin: null })).toBe('')
  })

  it('links to Facebook and names a website by its domain', () => {
    const html = render({ email: null, instagram: null, linkedin: null, facebook: 'https://www.facebook.com/guy', website: 'https://www.tiktok.com/@guy' })
    expect(html).toContain('href="https://www.facebook.com/guy"')
    expect(html).toContain('>tiktok.com</a>')
  })

  it('shows the X handle and links to the profile', () => {
    const html = render({ email: null, instagram: null, linkedin: null, x: 'jenny_c' })
    expect(html).toContain('href="https://x.com/jenny_c"')
    expect(html).toContain('>@jenny_c</a>')
  })

  it('shows the phone number and dials it without the formatting', () => {
    const html = render({ email: null, instagram: null, linkedin: null, phone: '+972 (50) 123-4567' })
    expect(html).toContain('href="tel:+972501234567"')
    expect(html).toContain('>+972 (50) 123-4567</a>')
  })

  it('links an email only when it is a plain address, and shows anything else as text', () => {
    const hidden = render({ email: 'me@example.com?cc=someone%40example.org&body=hi', instagram: null, linkedin: null })
    expect(hidden).not.toContain('mailto:')
    expect(hidden).not.toContain('<a')
    expect(hidden).toContain('me@example.com?cc=someone%40example.org&amp;body=hi')
    expect(render({ email: 'dana@example.com#top', instagram: null, linkedin: null })).not.toContain('mailto:')
    expect(render({ email: 'no-at-sign.example.com', instagram: null, linkedin: null })).not.toContain('mailto:')
    expect(render({ email: 'dana.zur@mail.example.com', instagram: null, linkedin: null })).toContain('href="mailto:dana.zur@mail.example.com"')
    expect(render({ email: 'first.last+x@ex-ample.co.il', instagram: null, linkedin: null })).toContain('href="mailto:first.last+x@ex-ample.co.il"')
  })
})

describe('notes', () => {
  const note = { id: 1, message: 'Meet me by the lockers', from: null, read: false, createdAt: '2026-09-18 20:00:00' }
  const card = (n: typeof note | (Omit<typeof note, 'from'> & { from: { id: number; name: string } })) =>
    renderToStaticMarkup(createElement(NoteCard, { note: n, index: 0, onOpen: () => {}, onThrowAway: () => {} }))

  it('keeps a note folded, message hidden, until it is opened', () => {
    const html = card(note)
    expect(html).toContain('פתק ממישהו מהמחזור')
    expect(html).not.toContain('Meet me by the lockers')
  })

  it('shows the message on notebook paper, signed by the sender or left anonymous', () => {
    expect(card({ ...note, read: true })).toContain('Meet me by the lockers')
    expect(card({ ...note, read: true })).toContain('notebook-paper')
    expect(card({ ...note, read: true, from: { id: 3, name: 'Guy' } })).toContain('>Guy</p>')
  })

  it('offers a reply only on an opened note that can be answered', () => {
    const withReply = (n: typeof note) => renderToStaticMarkup(createElement(NoteCard, { note: n, index: 0, onOpen: () => {}, onThrowAway: () => {}, onReply: () => {} }))
    expect(withReply({ ...note, read: true })).toContain('לענות')
    expect(withReply(note)).not.toContain('לענות')
    expect(card({ ...note, read: true })).not.toContain('לענות')
  })
})

describe('memories wall', () => {
  it('deals photos across the columns so the first ones make up the top row', () => {
    const columns = dealIntoColumns(['a', 'b', 'c', 'd', 'e'], 3)
    expect(columns.map((c) => c.map((p) => p.item))).toEqual([['a', 'd'], ['b', 'e'], ['c']])
    expect(columns[1][1].index).toBe(4)
  })
})

describe('yearbook grid', () => {
  const tag = (id: number, sceneId: number, personId: number | null, classLabel: string | null = null) => ({ id, sceneId, personId, x: 10, y: 10, w: 50, h: 60, caption: null, classLabel, staff: false })
  const scene = (id: number, kind: Scene['kind'], tags: ReturnType<typeof tag>[], year: number | null = null): Scene => ({ id, slug: `s${id}`, title: `S${id}`, kind, year, width: 1000, height: 800, dzi: '', tags })
  const scenes = [scene(1, 'group', [tag(11, 1, 7), tag(12, 1, null)]), scene(2, 'group', [tag(21, 2, 7), tag(22, 2, null)]), scene(3, 'mosaic', [tag(31, 3, null)])]
  const person = (extra: Partial<Person> = {}) => ({ id: 7, thenPhoto: null, nowPhoto: null, ...extra }) as Person

  it('shows your own 90s photo first, then your face on the newest class photo, then today', () => {
    expect(tilePhoto(person({ thenPhoto: '/media/then.webp' }), scenes)).toBe('/media/then.webp')
    expect(tilePhoto(person(), scenes)).toMatch(/^\/api\/tags\/21\/face/)
    expect(tilePhoto(person({ id: 8, nowPhoto: '/media/now.webp' }), scenes)).toBe('/media/now.webp')
    expect(tilePhoto(person({ id: 8 }), scenes)).toBeNull()
  })

  it('lists unnamed faces from class photos only, newest photo first', () => {
    expect(unknownFaces(scenes).map((t) => t.id)).toEqual([22, 12])
  })
})

describe('roster duplicates', () => {
  const tag = (id: number, sceneId: number, personId: number) => ({ id, sceneId, personId, x: 0, y: 0, w: 1, h: 1, caption: null, classLabel: null, staff: false })
  const scene = (id: number, tags: ReturnType<typeof tag>[]): Scene => ({ id, slug: `s${id}`, title: `S${id}`, kind: 'group', year: 1990 + id, width: 10, height: 10, dzi: '', tags })
  const people = [
    { id: 1, name: 'ד. אלמוני' },
    { id: 2, name: 'ד. אלמונני' },
    { id: 3, name: 'ד. אלמונני' },
    { id: 4, name: 'מ. אלמונני' },
  ] as Person[]

  it('ignores dots, spaces and final letters when comparing names', () => {
    expect(nameKey('א. בן-פלוני')).toBe('אבנפלוני')
    expect(nameKey('ד. פלמון')).toBe(nameKey('ד.פלמונ'))
  })

  it('pairs near-identical names from different posters, never two people on one poster or another initial', () => {
    const scenes = [scene(1, [tag(1, 1, 1)]), scene(2, [tag(2, 2, 2), tag(3, 2, 3), tag(4, 2, 4)])]
    expect(possibleDuplicates(people, scenes).map(([a, b]) => [a.id, b.id])).toEqual([[1, 2], [1, 3]])
  })
})

describe('welcome', () => {
  it('greets by the time of day', () => {
    expect([6, 13, 19, 23, 3].map(greeting)).toEqual(['בוקר טוב', 'צהריים טובים', 'ערב טוב', 'לילה טוב', 'לילה טוב'])
  })

  it('uses the nickname, else the first name, and keeps a poster name whole', () => {
    expect(firstName({ name: 'Dana Zur', nickname: 'Dandan' })).toBe('Dandan')
    expect(firstName({ name: 'Dana Zur', nickname: null })).toBe('Dana')
    expect(firstName({ name: 'י. ישראלי', nickname: null })).toBe('י. ישראלי')
  })
})

describe('slicing the yearbook', () => {
  const tag = (id: number, sceneId: number, personId: number | null, classLabel: string | null = null) => ({ id, sceneId, personId, x: 10, y: 10, w: 50, h: 60, caption: null, classLabel, staff: false })
  const scene = (id: number, year: number | null, tags: ReturnType<typeof tag>[], kind: Scene['kind'] = 'group'): Scene => ({ id, slug: `s${id}`, title: `S${id}`, kind, year, width: 1000, height: 800, dzi: '', tags })
  const scenes = [
    scene(1, 1993, [tag(11, 1, 1, "ט'-2"), tag(12, 1, 2, "ט'-10"), tag(13, 1, 3, "ט'-2")]),
    scene(2, 1996, [tag(21, 2, 1, 'י"ב-3'), tag(22, 2, 4, 'י"ב-1'), tag(23, 2, null, 'י"ב-1')]),
    scene(3, null, [tag(31, 3, 1)], 'mosaic'),
  ]
  const people = [
    { id: 1, name: 'י. ישראלי', gender: 'f' },
    { id: 2, name: 'א. בן-פלוני', gender: 'm' },
    { id: 3, name: 'דנה צור', gender: null },
    { id: 4, name: 'ד. פלוני', gender: 'm' },
    { id: 5, name: 'תמר שלא בתמונות', gender: 'f' },
  ] as Person[]
  const slice = (f: Partial<Filters>) => filterPeople(people, scenes, { ...NO_FILTERS, ...f }, matchesPerson).map((r) => r.person.id)

  it('offers each year with its classes in grade order, numbers counted as numbers', () => {
    expect(filterOptions(scenes)).toEqual([
      { year: 1993, classes: ["ט'-2", "ט'-10"] },
      { year: 1996, classes: ['י"ב-1', 'י"ב-3'] },
    ])
    expect(['י"ב-1', "ט'-7", "ו'-2"].sort(compareClass)).toEqual(["ו'-2", "ט'-7", 'י"ב-1'])
  })

  it('keeps everyone when nothing is chosen, sorted by surname for poster names', () => {
    expect(isFiltering(NO_FILTERS)).toBe(false)
    expect(slice({})).toEqual([2, 3, 1, 4, 5])
  })

  it('filters by year, class, gender and name, together', () => {
    expect(slice({ year: 1996 })).toEqual([1, 4])
    expect(slice({ classLabel: "ט'-2" })).toEqual([3, 1])
    expect(slice({ gender: 'm' })).toEqual([2, 4])
    expect(slice({ year: 1993, gender: 'f' })).toEqual([1])
    expect(slice({ query: 'ישראלי', year: 1996 })).toEqual([1])
    expect(slice({ year: 1993, classLabel: 'י"ב-3' })).toEqual([])
  })

  it("shows the face from the year that was asked for, and the newest one otherwise", () => {
    const row = (f: Partial<Filters>) => filterPeople(people, scenes, { ...NO_FILTERS, ...f }, matchesPerson).find((r) => r.person.id === 1)!
    expect(row({ year: 1993 }).appearance!.tag.id).toBe(11)
    expect(row({}).appearance!.tag.id).toBe(21)
  })

  it('sorts by class: newest poster first, classes in order, people without a class last', () => {
    expect(slice({ sort: 'class' })).toEqual([4, 1, 3, 2, 5])
  })
})

describe('mixtape shelf', () => {
  const tape = (id: number, provider: Tape['provider'], kind: string): Tape => ({
    id,
    provider,
    kind,
    externalId: `ext${id}`,
    title: `Tape ${id}`,
    addedBy: null,
    url: '',
  })
  const added = [tape(4, 'spotify', 'track'), tape(7, 'youtube', 'video')]

  it("puts the organizers' playlist first, and leaves it out when none is configured", () => {
    const shelf = buildShelf('PLhouse123456', 'Side A', added)
    expect(shelf.map((t) => t.id)).toEqual([0, 4, 7])
    expect(shelf[0]).toMatchObject({ provider: 'youtube', kind: 'playlist', externalId: 'PLhouse123456', title: 'Side A' })
    expect(buildShelf('', 'Side A', added)).toEqual(added)
  })

  it('falls back to the first tape when nothing is chosen or the chosen tape was removed', () => {
    expect(pickTape(added, 7)?.id).toBe(7)
    expect(pickTape(added, null)?.id).toBe(4)
    expect(pickTape(added, 99)?.id).toBe(4)
    expect(pickTape([], null)).toBeNull()
  })

  it('offers skip buttons only for YouTube playlists, and builds Spotify URIs', () => {
    expect(canSkip({ provider: 'youtube', kind: 'playlist' })).toBe(true)
    expect(canSkip({ provider: 'youtube', kind: 'video' })).toBe(false)
    expect(canSkip({ provider: 'spotify', kind: 'playlist' })).toBe(false)
    expect(canSkip(null)).toBe(false)
    expect(spotifyUri({ kind: 'album', externalId: 'abc' })).toBe('spotify:album:abc')
  })

  it('moves on to the next tape when one finishes, wrapping around, and stays put with a single tape', () => {
    const shelf = [tape(1, 'youtube', 'video'), ...added]
    expect(nextTape(shelf, shelf[0])?.id).toBe(4)
    expect(nextTape(shelf, shelf[2])?.id).toBe(1)
    expect(nextTape([shelf[0]], shelf[0])).toBeNull()
    expect(nextTape(shelf, null)).toBeNull()
  })

  it('treats a video as finished when it ends, but a playlist only after its last video', () => {
    expect(tapeFinished('video', 0, 0)).toBe(true)
    expect(tapeFinished('playlist', 2, 5)).toBe(false)
    expect(tapeFinished('playlist', 4, 5)).toBe(true)
  })

  it('loads no tape into the deck until the event details arrive, so no player is built only to be thrown away', () => {
    expect(deckTape(false, added, null)).toBeNull()
    expect(deckTape(false, added, 7)).toBeNull()
    // No house playlist: the tape stays the same once the details arrive, but the deck still has to load it.
    expect(deckTape(true, buildShelf('', 'Side A', added), null)?.id).toBe(4)
    expect(deckTape(true, buildShelf('PLhouse123456', 'Side A', added), null)?.id).toBe(0)
    expect(deckTape(true, buildShelf('PLhouse123456', 'Side A', added), 7)?.id).toBe(7)
  })
})

describe('mixtape player scripts', () => {
  type FakeScript = { src: string; onerror: (() => void) | null; remove: ReturnType<typeof vi.fn> }
  let scripts: FakeScript[]
  beforeEach(() => {
    scripts = []
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', {
      createElement: (): FakeScript => ({ src: '', onerror: null, remove: vi.fn() }),
      head: { appendChild: (script: FakeScript) => void scripts.push(script) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  const win = () => window as unknown as { onYouTubeIframeAPIReady?: () => void; onSpotifyIframeApiReady?: (api: unknown) => void }

  it('says the YouTube player did not load when its script fails, and tries again next time', async () => {
    const first = loadYouTubeApi()
    expect(scripts.map((s) => s.src)).toEqual(['https://www.youtube.com/iframe_api'])
    scripts[0].onerror!()
    await expect(first).rejects.toThrow('הנגן לא נטען')
    expect(scripts[0].remove).toHaveBeenCalled()

    const second = loadYouTubeApi()
    expect(scripts).toHaveLength(2)
    win().onYouTubeIframeAPIReady!()
    await expect(second).resolves.toBeUndefined()
  })

  it('does the same for Spotify', async () => {
    const first = loadSpotifyApi()
    expect(scripts.map((s) => s.src)).toEqual(['https://open.spotify.com/embed/iframe-api/v1'])
    scripts[0].onerror!()
    await expect(first).rejects.toThrow('הנגן לא נטען')

    const second = loadSpotifyApi()
    expect(scripts).toHaveLength(2)
    const api = { createController: () => {} }
    win().onSpotifyIframeApiReady!(api)
    await expect(second).resolves.toBe(api)
  })
})

describe('video library', () => {
  it('builds each provider\'s player from the ID, and only YouTube has a thumbnail', () => {
    expect(embedUrl({ provider: 'youtube', externalId: 'dQw4w9WgXcQ', url: '' })).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1',
    )
    expect(embedUrl({ provider: 'instagram', externalId: 'C1a2B3c4D5e', url: '' })).toBe('https://www.instagram.com/p/C1a2B3c4D5e/embed/')
    expect(embedUrl({ provider: 'x', externalId: '1790000000000000000', url: '' })).toContain('platform.twitter.com/embed/Tweet.html?id=1790000000000000000')
    expect(embedUrl({ provider: 'facebook', externalId: '123', url: 'https://www.facebook.com/watch/?v=123' })).toBe(
      'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D123&show_text=false&autoplay=true',
    )
    expect(thumbnailUrl({ provider: 'youtube', externalId: 'dQw4w9WgXcQ' })).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(thumbnailUrl({ provider: 'instagram', externalId: 'C1a2B3c4D5e' })).toBeNull()
    expect(thumbnailUrl({ provider: 'gphotos', externalId: 'vid-1' })).toBe('https://lh3.googleusercontent.com/pw/vid-1=w960')
    expect(streamUrl({ externalId: 'vid-1' })).toBe('https://lh3.googleusercontent.com/pw/vid-1=m18')
    expect([isTallEmbed('instagram'), isTallEmbed('x'), isTallEmbed('youtube'), isTallEmbed('facebook')]).toEqual([true, true, false, false])
  })
})

describe('RSVP shortcut', () => {
  const party = '2026-12-17T18:00:00'
  const now = new Date('2026-09-19T12:00:00').getTime()

  it('asks for an RSVP, with the date, until you answer yes or no', () => {
    expect(rsvpShortcut(null, party, now)).toEqual({ kind: 'ask', date: '17.12' })
    expect(rsvpShortcut('maybe', party, now)).toEqual({ kind: 'ask', date: '17.12' })
    expect(rsvpShortcut(undefined, 'soon', now)).toEqual({ kind: 'ask', date: null })
  })

  it('counts down once you have answered, and just names the event after it starts', () => {
    expect(rsvpShortcut('yes', party, now)).toEqual({ kind: 'going', days: 89 })
    expect(rsvpShortcut('no', party, now)).toEqual({ kind: 'answered', days: 89 })
    expect(rsvpShortcut('yes', 'soon', now)).toEqual({ kind: 'going', days: null })
    expect(rsvpShortcut(null, party, new Date('2026-12-17T18:00:00').getTime())).toEqual({ kind: 'over' })
  })

  it('counts the evening before as tomorrow and the morning of as today', () => {
    expect(rsvpShortcut('yes', party, new Date('2026-12-16T20:00:00').getTime())).toEqual({ kind: 'going', days: 1 })
    expect(rsvpShortcut('yes', party, new Date('2026-12-17T10:00:00').getTime())).toEqual({ kind: 'going', days: 0 })
  })

  it('says today and tomorrow in words', () => {
    expect([daysLeft(89), daysLeft(1), daysLeft(0), daysLeft(null)]).toEqual(['עוד 89 ימים', 'מחר!', 'היום!', 'האירוע'])
  })
})

describe('credits', () => {
  const render = (credits: { name: string; note?: string }[] | undefined, isAdmin = false) => renderToStaticMarkup(createElement(Credits, { credits, isAdmin }))

  it('thanks everyone on the list, with what they did', () => {
    const html = render([{ name: 'דנה', note: 'סרקה את ספר המחזור' }, { name: 'יוסי' }])
    expect(html).toContain('דנה')
    expect(html).toContain('סרקה את ספר המחזור')
    expect(html).toContain('יוסי')
  })

  it('renders nothing for everyone else when nobody is credited', () => {
    expect(render([])).toBe('')
    expect(render(undefined)).toBe('')
  })

  it('still shows the organizers an empty list, so they can fill it in', () => {
    const html = render([], true)
    expect(html).toContain('עריכה')
    expect(html).toContain('עוד לא הודינו לאף אחד')
  })

  it('does not offer the edit button to anyone else', () => {
    expect(render([{ name: 'דנה' }])).not.toContain('עריכה')
  })
})

describe('days until', () => {
  const party = new Date('2026-12-17T18:00:00')

  it('counts calendar days, not 24-hour stretches', () => {
    expect(daysUntil(party, new Date('2026-12-16T20:00:00'))).toBe(1)
    expect(daysUntil(party, new Date('2026-12-17T10:00:00'))).toBe(0)
    expect(daysUntil(party, new Date('2026-12-15T23:59:00'))).toBe(2)
  })

  it('goes negative once the day has passed', () => {
    expect(daysUntil(party, new Date('2026-12-18T09:00:00'))).toBe(-1)
  })
})

describe('profile form', () => {
  it('keeps what you typed when the profile reloads, and starts over for another profile', () => {
    expect(shouldResetDraft(7, 7, true)).toBe(false)
    expect(shouldResetDraft(7, 7, false)).toBe(true)
    expect(shouldResetDraft(null, 7, false)).toBe(true)
    expect(shouldResetDraft(7, 8, true)).toBe(true)
    expect(shouldResetDraft(7, null, true)).toBe(true)
  })
})

describe('checking an edit token', () => {
  afterEach(() => vi.unstubAllGlobals())
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it('asks the server about the new token itself', async () => {
    const fetch = reply(200, { id: 7, name: 'Dana' })
    vi.stubGlobal('fetch', fetch)
    expect(await checkEditToken('new-token')).toMatchObject({ id: 7 })
    expect(fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({ headers: { 'x-edit-token': 'new-token' } }))
  })

  it('says a dead link is dead, and asks to try again when the network fails', async () => {
    vi.stubGlobal('fetch', reply(403, { error: 'קישור העריכה אינו תקף' }))
    await expect(checkEditToken('old-token')).rejects.toThrow('כבר לא בתוקף')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(checkEditToken('old-token')).rejects.toThrow('שוב')
  })
})

describe('adopting an edit token', () => {
  const saved = new Map<string, string>()
  beforeEach(() => {
    saved.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    })
    editToken.set('old-token')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the token this device had when the server refuses the new one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'קישור העריכה אינו תקף' }), { status: 403 })))
    await expect(adoptEditToken('dead-token')).rejects.toThrow('כבר לא בתוקף')
    expect(editToken.get()).toBe('old-token')
  })

  it('keeps it through a network failure too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(adoptEditToken('new-token')).rejects.toThrow()
    expect(editToken.get()).toBe('old-token')
  })

  it('stores the new token once the server knows it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 7, name: 'Dana' }), { status: 200 })))
    expect(await adoptEditToken('new-token')).toMatchObject({ id: 7 })
    expect(editToken.get()).toBe('new-token')
  })
})

describe('spotify tape end', () => {
  const update = (isPaused: boolean, position: number, isBuffering = false) => ({ isPaused, isBuffering, position, duration: 200_000 })

  it('finishes when the tape stops by itself at the end, not when someone pauses it', () => {
    const ended = spotifyEndWatcher()
    expect(ended(update(true, 0), 0)).toBe(false)
    expect(ended(update(false, 60_000), 1_000)).toBe(false)
    expect(ended(update(true, 60_000), 2_000)).toBe(false)
    expect(ended(update(false, 199_000), 5_000)).toBe(false)
    expect(ended(update(true, 200_000, true), 6_000)).toBe(false)
    expect(ended(update(true, 200_000), 6_000)).toBe(true)
  })

  it('also counts a tape that rewinds to the start right after reaching the end', () => {
    const ended = spotifyEndWatcher()
    ended(update(false, 199_000), 0)
    expect(ended(update(true, 0), 800)).toBe(true)
    const stopped = spotifyEndWatcher()
    stopped(update(false, 100_000), 0)
    expect(stopped(update(true, 0), 800)).toBe(false)
  })

  it('does not count a pause the site asked for, even right at the end', () => {
    const ended = spotifyEndWatcher()
    ended(update(false, 199_000), 0)
    expect(ended(update(true, 199_500), 500, true)).toBe(false)
    expect(ended(update(true, 199_500), 900)).toBe(false)
    ended(update(false, 199_500), 5_000)
    expect(ended(update(true, 200_000), 5_500)).toBe(true)
  })

  it('does not count the buffering between the songs of an album', () => {
    const ended = spotifyEndWatcher()
    ended(update(false, 199_000), 0)
    expect(ended(update(true, 200_000), 1_000)).toBe(true)
    expect(ended(update(true, 0, true), 1_200)).toBe(false)
    expect(ended(update(false, 0, true), 1_400)).toBe(false)
    expect(ended(update(false, 300), 1_700)).toBe(false)
    expect(ended(update(true, 400), 1_800)).toBe(false)
  })
})

describe('notes inbox actions', () => {
  it('reloads the inbox once the action went through', async () => {
    const reload = vi.fn(async () => {})
    expect(await noteAction(async () => {}, reload)).toBe('')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('says what went wrong, and sends the request again on the next try', async () => {
    const reload = vi.fn(async () => {})
    const action = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new ApiError(429, 'יותר מדי בקשות. נסו שוב בעוד רגע.'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(undefined)
    expect(await noteAction(action, reload)).toBe('יותר מדי בקשות. נסו שוב בעוד רגע.')
    expect(await noteAction(action, reload)).toBe('אין חיבור לאתר כרגע. בדקו את האינטרנט ונסו שוב.')
    expect(reload).not.toHaveBeenCalled()
    expect(await noteAction(action, reload)).toBe('')
    expect(action).toHaveBeenCalledTimes(3)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('also says so when the inbox fails to reload afterwards', async () => {
    expect(await noteAction(async () => {}, async () => Promise.reject(new TypeError('Failed to fetch')))).toContain('אין חיבור')
  })

  it('counts throwing away a note that is already gone as done, and reloads the inbox', async () => {
    const reload = vi.fn(async () => {})
    expect(await noteAction(() => ignoreGone(Promise.reject(new ApiError(404, 'Not found'))), reload)).toBe('')
    expect(reload).toHaveBeenCalledOnce()
    expect(await noteAction(() => ignoreGone(Promise.reject(new ApiError(500, 'משהו השתבש'))), reload)).toBe('משהו השתבש')
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe('claiming a profile', () => {
  const nudge = (email: string) => renderToStaticMarkup(createElement(ClaimNudge, { email }))

  it('warns over the claim button while the email is empty, whatever code was chosen', () => {
    const warning = 'בלי מייל, אם תשכחו את הקוד רק מארגן יוכל להחזיר אתכם לפרופיל.'
    expect(nudge('')).toContain(warning)
    expect(nudge('  ')).toContain(warning)
  })

  it('says nothing once there is an email', () => {
    expect(nudge('dana@example.com')).toBe('')
  })
})

describe('class filter', () => {
  const tag = (id: number, sceneId: number, classLabel: string) => ({ id, sceneId, personId: id, x: 0, y: 0, w: 1, h: 1, caption: null, classLabel, staff: false })
  const scene = (id: number, year: number, tags: ReturnType<typeof tag>[]): Scene => ({ id, slug: `s${id}`, title: `S${id}`, kind: 'group', year, width: 10, height: 10, dzi: '', tags })
  // The same class name printed on two posters.
  const scenes = [scene(1, 1991, [tag(1, 1, 'א-1'), tag(2, 1, 'א-2')]), scene(2, 1992, [tag(3, 2, 'א-1')])]
  const options = filterOptions(scenes)
  const menu = (f: Partial<Filters>) =>
    renderToStaticMarkup(createElement(FriendFilters, { scenes, filters: { ...NO_FILTERS, ...f }, onChange: () => {}, total: 3, shown: 3, genders: false }))

  it('keeps the chosen year when one of its classes is picked, even if an older poster has the same class', () => {
    expect(pickClass(classValue(1992, 'א-1'), { ...NO_FILTERS, year: 1992 })).toEqual({ year: 1992, classLabel: 'א-1' })
  })

  it('takes the year from the poster the class was picked under when all years are listed', () => {
    expect(pickClass(classValue(1992, 'א-1'), NO_FILTERS)).toEqual({ year: 1992, classLabel: 'א-1' })
    expect(pickClass(classValue(1991, 'א-1'), NO_FILTERS)).toEqual({ year: 1991, classLabel: 'א-1' })
  })

  it('keeps the year when the class is cleared', () => {
    expect(pickClass('', { ...NO_FILTERS, year: 1992, classLabel: 'א-1' })).toEqual({ year: 1992, classLabel: null })
  })

  it('tells the two posters apart in the menu and shows the one that is chosen', () => {
    const all = menu({})
    expect(all).toContain('value="1991|א-1"')
    expect(all).toContain('value="1992|א-1"')
    expect(menu({ year: 1992, classLabel: 'א-1' })).toContain('<option value="1992|א-1" selected="">')
    expect(classMenuValue(options, { ...NO_FILTERS, year: 1992, classLabel: 'א-1' })).toBe('1992|א-1')
    // A shared link with a class and no year: the oldest poster that has that class.
    expect(classMenuValue(options, { ...NO_FILTERS, classLabel: 'א-1' })).toBe('1991|א-1')
    expect(classMenuValue(options, NO_FILTERS)).toBe('')
  })
})

describe('faces on the class photo, by keyboard', () => {
  const face = (id: number, x: number, y: number) => ({ id, x, y, w: 60, h: 80 })
  // Two rows of three, a little uneven like a scanned poster.
  const grid = [face(1, 0, 0), face(2, 100, 4), face(3, 200, -3), face(4, 0, 120), face(5, 100, 118), face(6, 200, 125)]
  const go = (from: number, key: string) => neighborFace(grid, grid.find((t) => t.id === from)!, faceDirection(key)!)?.id ?? null

  it('moves to the next face along the row or the column', () => {
    expect([go(1, 'ArrowRight'), go(2, 'ArrowLeft'), go(2, 'ArrowDown'), go(5, 'ArrowUp'), go(4, 'ArrowRight')]).toEqual([2, 1, 5, 2, 5])
  })

  it('stays put at the edge of the photo instead of jumping to another row', () => {
    expect([go(3, 'ArrowRight'), go(1, 'ArrowUp'), go(4, 'ArrowLeft'), go(6, 'ArrowDown')]).toEqual([null, null, null, null])
  })

  it('answers only the arrow keys', () => {
    expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].map(faceDirection)).toEqual(['left', 'right', 'up', 'down', null, null])
  })

  it('starts at the right end of the top row, where a Hebrew reader starts', () => {
    expect(firstFace(grid)?.id).toBe(3)
    expect(firstFace([])).toBeNull()
  })

  it('moves the picture only for keyboard focus, and assumes keyboard where the browser cannot tell', () => {
    const element = (matches: () => boolean) => ({ matches }) as unknown as Element
    expect(focusVisible(element(() => true))).toBe(true)
    expect(focusVisible(element(() => false))).toBe(false)
    const oldSafari = element(() => {
      throw new SyntaxError("':focus-visible' is not a valid selector")
    })
    expect(focusVisible(oldSafari)).toBe(true)
  })

  it('says when the class photo did not load, with a way to try again', () => {
    const html = renderToStaticMarkup(createElement(SceneOpenFailed, { onRetry: () => {} }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('התמונה לא נטענה')
    expect(html).toContain('נסו שוב')
  })
})

describe('escape key', () => {
  type Listener = (e: KeyboardEvent) => void
  let listeners: Listener[]
  beforeEach(() => {
    listeners = []
    vi.stubGlobal('window', {
      addEventListener: (_type: string, fn: Listener) => void listeners.push(fn),
      removeEventListener: (_type: string, fn: Listener) => void (listeners = listeners.filter((l) => l !== fn)),
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  const press = (key = 'Escape', defaultPrevented = false) => {
    const e = { key, defaultPrevented, preventDefault: vi.fn() }
    for (const listener of listeners) listener(e as unknown as KeyboardEvent)
    return e
  }

  it('closes only the top-most window: the highest layer first, then the most recently opened', () => {
    const closed: string[] = []
    const offDrawer = pushEscape(LAYER.drawer, () => closed.push('drawer'))
    const offDialog = pushEscape(LAYER.dialog, () => closed.push('dialog'))
    const offPicture = pushEscape(LAYER.picture, () => closed.push('picture'))
    const offNewerDrawer = pushEscape(LAYER.drawer, () => closed.push('newer drawer'))
    press()
    offDialog()
    press()
    offNewerDrawer()
    press()
    offDrawer()
    press()
    offPicture()
    expect(closed).toEqual(['dialog', 'newer drawer', 'drawer', 'picture'])
  })

  it('keeps the key from doing anything else, and leaves other keys and handled presses alone', () => {
    const run = vi.fn()
    const off = pushEscape(LAYER.drawer, run)
    expect(press().preventDefault).toHaveBeenCalled()
    expect(press('Enter').preventDefault).not.toHaveBeenCalled()
    press('Escape', true)
    off()
    expect(run).toHaveBeenCalledOnce()
  })

  it('takes off only its own handler, even when its cleanup runs twice', () => {
    const closed: string[] = []
    const offDrawer = pushEscape(LAYER.drawer, () => closed.push('drawer'))
    const offDialog = pushEscape(LAYER.dialog, () => closed.push('dialog'))
    offDrawer()
    offDrawer()
    press()
    offDialog()
    expect(closed).toEqual(['dialog'])
    expect(listeners).toHaveLength(0)
  })

  it('listens only while something is open', () => {
    expect(listeners).toHaveLength(0)
    const offA = pushEscape(LAYER.drawer, () => {})
    const offB = pushEscape(LAYER.dialog, () => {})
    expect(listeners).toHaveLength(1)
    offA()
    expect(listeners).toHaveLength(1)
    offB()
    expect(listeners).toHaveLength(0)
  })
})

describe('loading the site', () => {
  it('answers nothing when the request went through', async () => {
    expect(await attempt(async () => {})).toBe('')
  })

  it("says why it failed: the server's words, or that the site can't be reached", async () => {
    expect(await attempt(async () => Promise.reject(new ApiError(500, 'משהו השתבש')))).toBe('משהו השתבש')
    expect(await attempt(async () => Promise.reject(new TypeError('Failed to fetch')))).toBe('אין חיבור לאתר כרגע. בדקו את האינטרנט ונסו שוב.')
  })

  it('blames the connection only for a request that never got an answer', async () => {
    expect(await attempt(async () => Promise.reject(new Error('Unexpected')))).toBe('משהו השתבש')
    expect(await attempt(async () => Promise.reject('odd'))).toBe('משהו השתבש')
  })

  it('shows a failed first load with a way to try again, not an empty yearbook', () => {
    const html = renderToStaticMarkup(createElement(LoadFailed, { message: 'משהו השתבש', busy: false, onRetry: () => {} }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('משהו השתבש')
    expect(html).toContain('נסו שוב')
    expect(html).not.toContain('disabled')
  })

  it('keeps the message up with a busy button while it tries again', () => {
    const html = renderToStaticMarkup(createElement(LoadFailed, { message: 'משהו השתבש', busy: true, onRetry: () => {} }))
    expect(html).toContain('משהו השתבש')
    expect(html).toContain('disabled=""')
    expect(html).toContain('מנסים שוב...')
  })
})
