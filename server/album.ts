// Google Photos has no public API for shared albums any more, so we read the photo links out of the
// shared album page itself. This is unofficial: if Google changes the page, this returns an empty list
// and the Memories page falls back to a plain link.

export interface AlbumPhoto {
  src: string
  width: number
  height: number
  /** Only set on videos. `src` is then the poster frame, and `src=m18` streams it as 360p mp4. */
  durationMs?: number
  /** Only set on videos: the album item's id ("AF1Qip..."), which stays put, so the event config can name the video. */
  itemId?: string
}

const CACHE_MS = 30 * 60 * 1000
const MAX_PHOTOS = 500
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * Pulls ["https://lh3.googleusercontent.com/pw/...", width, height] entries out of the album page, newest first.
 * Each entry is followed by `]],<taken>,"<key>",<tz offset>,<added>`; when every photo has that date added we sort
 * by it, otherwise we fall back to reversing the album's own order (oldest first by default).
 */
export function parseAlbumPage(html: string): AlbumPhoto[] {
  const seen = new Set<string>()
  const photos: (AlbumPhoto & { added: number })[] = []
  const entry = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+)",(\d+),(\d+)(?:.{0,1000}?\]\],\d{10,},"[^"]*",-?\d+,(\d{10,}))?/g
  for (const match of html.matchAll(entry)) {
    const [, src, width, height, added] = match
    if (seen.has(src)) continue
    seen.add(src)
    photos.push({ src, width: Number(width), height: Number(height), added: Number(added ?? 0) })
  }
  photos.reverse()
  if (photos.every((p) => p.added)) photos.sort((a, b) => b.added - a.added)
  // A video's entry also carries "76647426":[<duration ms>, null, w, h, ..., ["<its url>"]].
  const durations = new Map<string, number>()
  for (const [, ms, src] of html.matchAll(/"76647426":\[(\d+),[^[\]]*\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+)"\]\]/g)) {
    durations.set(src, Number(ms))
  }
  const itemIds = new Map<string, string>()
  for (const [, id, src] of html.matchAll(/\["(AF1Qip[A-Za-z0-9_-]+)",\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+)"/g)) itemIds.set(src, id)
  return photos.slice(0, MAX_PHOTOS).map(({ added: _added, ...photo }) => {
    const durationMs = durations.get(photo.src)
    if (durationMs === undefined) return photo
    const itemId = itemIds.get(photo.src)
    return itemId ? { ...photo, durationMs, itemId } : { ...photo, durationMs }
  })
}

let cache: { url: string; at: number; photos: AlbumPhoto[] } | null = null

/** Photos only: the album's videos go to the video library instead (see albumVideos). */
export async function albumPhotos(albumUrl: string): Promise<AlbumPhoto[]> {
  return (await albumItems(albumUrl)).filter((p) => p.durationMs === undefined)
}

export async function albumVideos(albumUrl: string): Promise<AlbumPhoto[]> {
  return (await albumItems(albumUrl)).filter((p) => p.durationMs !== undefined)
}

async function albumItems(albumUrl: string): Promise<AlbumPhoto[]> {
  if (!/^https:\/\/(photos\.google\.com|photos\.app\.goo\.gl)\//.test(albumUrl)) return []
  if (cache && cache.url === albumUrl && Date.now() - cache.at < CACHE_MS) return cache.photos
  try {
    const res = await fetch(albumUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) })
    const photos = res.ok ? parseAlbumPage(await res.text()) : []
    // Keep serving the last good list if a refresh comes back empty.
    if (photos.length || !cache || cache.url !== albumUrl) cache = { url: albumUrl, at: Date.now(), photos }
    else cache.at = Date.now()
  } catch (err) {
    console.error('Album fetch failed:', (err as Error).message)
    if (!cache || cache.url !== albumUrl) cache = { url: albumUrl, at: Date.now() - CACHE_MS + 60_000, photos: [] }
  }
  return cache.photos
}
