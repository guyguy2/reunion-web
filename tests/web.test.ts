import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Tape } from '../web/src/api.ts'
import ContactLinks from '../web/src/components/ContactLinks.tsx'
import { buildShelf, canSkip, nextTape, pickTape, spotifyUri, tapeFinished } from '../web/src/tapes.ts'
import { embedUrl, isTallEmbed, thumbnailUrl } from '../web/src/videos.ts'

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
    expect([isTallEmbed('instagram'), isTallEmbed('x'), isTallEmbed('youtube'), isTallEmbed('facebook')]).toEqual([true, true, false, false])
  })
})
