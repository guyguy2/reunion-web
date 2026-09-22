import type { AlbumPhoto } from './album.ts'
import type { Db, VideoRow } from './db.ts'

export type VideoProvider = 'youtube' | 'instagram' | 'facebook' | 'x'

export interface VideoSource {
  provider: VideoProvider
  externalId: string
}

const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/
const IG_CODE = /^[A-Za-z0-9_-]{5,40}$/
const NUMERIC_ID = /^\d{5,25}$/
const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']
const IG_HOSTS = ['instagram.com', 'www.instagram.com', 'instagr.am', 'www.instagr.am']
const FB_HOSTS = ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com']
const X_HOSTS = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com']

function youtube(url: URL, parts: string[]): string | null {
  let id = url.searchParams.get('v')
  if (url.hostname.toLowerCase() === 'youtu.be') id = parts[0] ?? null
  else if (['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1] ?? null
  return id && YT_VIDEO.test(id) ? id : null
}

// /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>, optionally after the account name.
function instagram(parts: string[]): string | null {
  const at = parts.findIndex((p) => ['p', 'reel', 'reels', 'tv'].includes(p))
  const code = at >= 0 ? parts[at + 1] : undefined
  return code && IG_CODE.test(code) ? code : null
}

// /watch?v=<id>, /reel/<id>, /<page>/videos/<id>, /<page>/videos/<slug>/<id>, /video.php?v=<id>
function facebook(url: URL, parts: string[]): string | null {
  const v = url.searchParams.get('v')
  if ((parts[0] === 'watch' || parts[0] === 'video.php') && v && NUMERIC_ID.test(v)) return v
  if (parts[0] === 'reel' && NUMERIC_ID.test(parts[1] ?? '')) return parts[1]
  const at = parts.indexOf('videos')
  if (at < 0) return null
  return parts.slice(at + 1).find((p) => NUMERIC_ID.test(p)) ?? null
}

// /<user>/status/<id>, /i/status/<id>, with or without a trailing /video/1
function x(parts: string[]): string | null {
  const at = parts.indexOf('status')
  const id = at >= 0 ? parts[at + 1] : undefined
  return id && NUMERIC_ID.test(id) ? id : null
}

/** Understands video links people paste from YouTube, Instagram, Facebook and X (Twitter). */
export function parseVideoLink(input: string): VideoSource | null {
  const text = input.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  const found = (provider: VideoProvider, externalId: string | null) => (externalId ? { provider, externalId } : null)
  if (YT_HOSTS.includes(host)) return found('youtube', youtube(url, parts))
  if (IG_HOSTS.includes(host)) return found('instagram', instagram(parts))
  if (FB_HOSTS.includes(host)) return found('facebook', facebook(url, parts))
  if (X_HOSTS.includes(host)) return found('x', x(parts))
  return null
}

/** The public page for a video, rebuilt from the validated ID (never the pasted text). */
export function videoUrl({ provider, externalId }: VideoSource): string {
  if (provider === 'instagram') return `https://www.instagram.com/p/${externalId}/`
  if (provider === 'facebook') return `https://www.facebook.com/watch/?v=${externalId}`
  if (provider === 'x') return `https://x.com/i/status/${externalId}`
  return `https://www.youtube.com/watch?v=${externalId}`
}

/** YouTube gives the video title and X the author. Instagram and Facebook need an app token, so no lookup. */
export async function lookupVideoTitle(source: VideoSource): Promise<string | null> {
  const endpoint = { youtube: 'https://www.youtube.com/oembed', x: 'https://publish.twitter.com/oembed' }[source.provider as string]
  if (!endpoint) return null
  try {
    const res = await fetch(`${endpoint}?format=json&omit_script=1&url=${encodeURIComponent(videoUrl(source))}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { title?: unknown; author_name?: unknown }
    const title = source.provider === 'x' ? (typeof data.author_name === 'string' && data.author_name.trim() ? `פוסט של ${data.author_name.trim()}` : null) : data.title
    return typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null
  } catch {
    return null
  }
}

export function serializeVideo(row: VideoRow) {
  const source: VideoSource = { provider: row.provider, externalId: row.external_id }
  return { id: row.id, ...source, title: row.title, note: row.note, addedBy: row.added_by, url: videoUrl(source) }
}

export interface FeaturedVideo {
  title: string
  url: string
  note?: string
}

/** The organizers' videos from the event config come first, with ids 0, -1, -2... so they cannot be removed from the site. */
export function listVideos(db: Db, featured: FeaturedVideo[] = []) {
  const pinned = featured.flatMap((v) => {
    const source = parseVideoLink(v.url ?? '')
    return source ? [{ ...source, title: v.title, note: v.note ?? null, addedBy: null, url: videoUrl(source) }] : []
  })
  const rows = db.prepare('SELECT * FROM videos ORDER BY id').all() as unknown as VideoRow[]
  return [...pinned.map((v, i) => ({ id: i ? -i : 0, ...v })), ...rows.map(serializeVideo)]
}

/** Videos from the shared Google Photos album. They live in the album, so they can't be removed here (negative ids). */
export function albumVideoEntries(videos: AlbumPhoto[], albumUrl: string) {
  return videos.map((v, i) => ({
    id: -1000 - i,
    provider: 'gphotos' as const,
    externalId: v.src.split('/pw/')[1],
    title: 'סרטון מהאלבום המשותף',
    note: v.durationMs ? `אורך: ${formatDuration(v.durationMs)}` : null,
    addedBy: null,
    url: albumUrl,
  }))
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const FALLBACK_TITLE: Record<VideoProvider, string> = {
  youtube: 'סרטון מיוטיוב',
  instagram: 'סרטון מאינסטגרם',
  facebook: 'סרטון מפייסבוק',
  x: 'סרטון מ-X',
}

/** Validates and stores a classmate's video link. Throws Error with a user-facing message on bad input. */
export async function addVideo(db: Db, body: unknown, titleLookup = lookupVideoTitle) {
  const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
  const link = text('url')
  if (/^(https?:\/\/)?([a-z]+\.)?(fb\.watch\/|facebook\.com\/share\/)/i.test(link)) {
    throw new Error('קישור שיתוף של פייסבוק לא נתמך. פתחו אותו בדפדפן והדביקו את הכתובת המלאה של הסרטון')
  }
  const source = parseVideoLink(link)
  if (!source) throw new Error('הדביקו קישור לסרטון מיוטיוב, אינסטגרם, פייסבוק או X')
  const title = text('title')
  const note = text('note') || null
  const addedBy = text('addedBy') || null
  if (title.length > 80 || (note && note.length > 300) || (addedBy && addedBy.length > 60)) throw new Error('הטקסט ארוך מדי')
  const exists = db.prepare('SELECT 1 FROM videos WHERE provider = ? AND external_id = ?').get(source.provider, source.externalId)
  if (exists) throw new Error('הסרטון הזה כבר בספרייה')
  const finalTitle = title || (await titleLookup(source)) || FALLBACK_TITLE[source.provider]
  const result = db
    .prepare('INSERT INTO videos (provider, external_id, title, note, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(source.provider, source.externalId, finalTitle, note, addedBy)
  return serializeVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as VideoRow)
}
