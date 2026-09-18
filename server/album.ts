// Google Photos has no public API for shared albums any more, so we read the photo links out of the
// shared album page itself. This is unofficial: if Google changes the page, this returns an empty list
// and the Memories page falls back to a plain link.

export interface AlbumPhoto {
  src: string
  width: number
  height: number
}

const CACHE_MS = 30 * 60 * 1000
const MAX_PHOTOS = 120
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Pulls ["https://lh3.googleusercontent.com/pw/...", width, height] entries out of the album page. */
export function parseAlbumPage(html: string): AlbumPhoto[] {
  const seen = new Set<string>()
  const photos: AlbumPhoto[] = []
  for (const match of html.matchAll(/\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]+)",(\d+),(\d+)/g)) {
    const [, src, width, height] = match
    if (seen.has(src)) continue
    seen.add(src)
    photos.push({ src, width: Number(width), height: Number(height) })
  }
  return photos.slice(0, MAX_PHOTOS)
}

let cache: { url: string; at: number; photos: AlbumPhoto[] } | null = null

export async function albumPhotos(albumUrl: string): Promise<AlbumPhoto[]> {
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
