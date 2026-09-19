import type { Db, TapeRow } from './db.ts'

export interface TapeSource {
  provider: 'youtube' | 'spotify'
  kind: string
  externalId: string
}

const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/
// A bare ID (no link) must look like one of YouTube's playlist kinds, so a stray word is not taken for one.
const YT_BARE_LIST = /^(PL|OL|RD|UU|FL)[A-Za-z0-9_-]{8,62}$/
const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']
const SPOTIFY_KINDS = ['track', 'album', 'playlist', 'artist', 'episode', 'show']
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/

function youtube(url: URL): TapeSource | null {
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  const list = url.searchParams.get('list')
  let video = url.searchParams.get('v')
  if (host === 'youtu.be') video = parts[0] ?? null
  else if (['shorts', 'live', 'embed'].includes(parts[0])) video = parts[1] ?? null
  const hasList = !!list && YT_LIST.test(list)
  const hasVideo = !!video && YT_VIDEO.test(video)
  // A video playing inside a playlist means the playlist. Radio mixes ("RD...") are made per listener and
  // often refuse to embed, so for those keep just the song.
  if (hasList && !(hasVideo && list!.startsWith('RD'))) return { provider: 'youtube', kind: 'playlist', externalId: list! }
  if (hasVideo) return { provider: 'youtube', kind: 'video', externalId: video! }
  return null
}

function spotify(url: URL): TapeSource | null {
  const parts = url.pathname.split('/').filter(Boolean)
  // Localized links look like /intl-he/track/<id>.
  if (parts[0]?.startsWith('intl-')) parts.shift()
  const [kind, id] = parts
  if (!SPOTIFY_KINDS.includes(kind) || !SPOTIFY_ID.test(id ?? '')) return null
  return { provider: 'spotify', kind, externalId: id }
}

/** Understands what people paste: YouTube and YouTube Music videos, songs and playlists, and Spotify links or URIs. */
export function parseTapeLink(input: string): TapeSource | null {
  const text = input.trim()
  if (YT_BARE_LIST.test(text)) return { provider: 'youtube', kind: 'playlist', externalId: text }
  const uri = text.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/)
  if (uri) return SPOTIFY_KINDS.includes(uri[1]) && SPOTIFY_ID.test(uri[2]) ? { provider: 'spotify', kind: uri[1], externalId: uri[2] } : null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (YT_HOSTS.includes(host)) return youtube(url)
  if (host === 'open.spotify.com') return spotify(url)
  return null
}

/** The public page for a tape, used for oEmbed title lookups and "open in" links. */
export function tapeUrl(source: TapeSource): string {
  if (source.provider === 'spotify') return `https://open.spotify.com/${source.kind}/${source.externalId}`
  return source.kind === 'playlist'
    ? `https://www.youtube.com/playlist?list=${source.externalId}`
    : `https://www.youtube.com/watch?v=${source.externalId}`
}

/** Asks YouTube or Spotify for the title. Best effort: returns null when the lookup fails. */
export async function lookupTitle(source: TapeSource): Promise<string | null> {
  const endpoint = source.provider === 'spotify' ? 'https://open.spotify.com/oembed' : 'https://www.youtube.com/oembed'
  try {
    const res = await fetch(`${endpoint}?format=json&url=${encodeURIComponent(tapeUrl(source))}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const title = ((await res.json()) as { title?: unknown }).title
    return typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : null
  } catch {
    return null
  }
}

export function serializeTape(row: TapeRow) {
  const source: TapeSource = { provider: row.provider, kind: row.kind, externalId: row.external_id }
  return { id: row.id, ...source, title: row.title, addedBy: row.added_by, url: tapeUrl(source) }
}

export function listTapes(db: Db) {
  const rows = db.prepare('SELECT * FROM tapes ORDER BY id').all() as unknown as TapeRow[]
  return rows.map(serializeTape)
}

/** Validates and stores a classmate's tape. Throws Error with a user-facing message on bad input. */
export async function addTape(db: Db, body: unknown, titleLookup = lookupTitle) {
  const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
  const link = text('url')
  if (/^(https?:\/\/)?spotify\.link\//i.test(link)) {
    throw new Error('קישור מקוצר של ספוטיפיי לא נתמך. פתחו אותו בדפדפן והדביקו את הכתובת המלאה (open.spotify.com)')
  }
  const source = parseTapeLink(link)
  if (!source) throw new Error('הדביקו קישור לשיר, סרטון, אלבום או פלייליסט מיוטיוב, YouTube Music או ספוטיפיי')
  const addedBy = text('addedBy') || null
  if (text('title').length > 60 || (addedBy && addedBy.length > 60)) throw new Error('הטקסט ארוך מדי')
  const exists = db
    .prepare('SELECT 1 FROM tapes WHERE provider = ? AND kind = ? AND external_id = ?')
    .get(source.provider, source.kind, source.externalId)
  if (exists) throw new Error('הקלטת הזו כבר על המדף')
  const title = text('title') || (await titleLookup(source)) || 'קלטת בלי שם'
  const result = db
    .prepare('INSERT INTO tapes (provider, kind, external_id, title, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(source.provider, source.kind, source.externalId, title, addedBy)
  return serializeTape(db.prepare('SELECT * FROM tapes WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as TapeRow)
}
