export type Role = 'member' | 'admin'

export interface Photo {
  id: number
  url: string
}

export interface Person {
  id: number
  name: string
  formerName: string | null
  nickname: string | null
  email: string | null
  instagram: string | null
  linkedin: string | null
  facebook: string | null
  website: string | null
  phone: string | null
  x: string | null
  city: string | null
  bio: string | null
  quote: string | null
  /** The first "then" / "now" photo, for the wall, the tiles and the then-and-now slider. */
  thenPhoto: string | null
  nowPhoto: string | null
  thenPhotos: Photo[]
  nowPhotos: Photo[]
  attending: 'yes' | 'no' | 'maybe' | null
  gender: 'm' | 'f' | null
  inMemoriam: boolean
  claimed: boolean
  /** Whether the owner has chosen a personal code for signing in on other devices. */
  hasPin: boolean
  showEmail?: boolean
  showInstagram?: boolean
  showLinkedin?: boolean
  showFacebook?: boolean
  showWebsite?: boolean
  showPhone?: boolean
  showX?: boolean
  /** Only on your own profile (GET /api/me). */
  unreadNotes?: number
}

export interface Tag {
  id: number
  sceneId: number
  personId: number | null
  x: number
  y: number
  w: number
  h: number
  /** The name printed under the face on the poster. */
  caption: string | null
  classLabel: string | null
  /** Staff faces only ever reach the organizers' roster tool. */
  staff: boolean
}

export interface Scene {
  id: number
  slug: string
  title: string
  kind: 'mosaic' | 'group'
  year: number | null
  width: number
  height: number
  dzi: string
  tags: Tag[]
}

/** A tape on the mixtape shelf. `kind` is 'video' or 'playlist' for YouTube, or a Spotify type such as 'track' or 'album'. */
export interface Tape {
  id: number
  provider: 'youtube' | 'spotify'
  kind: string
  externalId: string
  title: string
  addedBy: string | null
  url: string
}

/**
 * A classmate's video link. The embed and the "open" link are rebuilt from `provider` and `externalId`.
 * 'gphotos' is a video from the shared album: `externalId` is its Google image id and `url` the album.
 */
export interface Video {
  id: number
  provider: 'youtube' | 'instagram' | 'facebook' | 'x' | 'gphotos'
  externalId: string
  title: string
  note: string | null
  addedBy: string | null
  url: string
}

/** A comment under a quote. */
export interface QuoteComment {
  id: number
  message: string
  addedBy: string | null
  createdAt: string
}

/** Something a teacher or classmate used to say, with the comments under it. */
export interface Quote {
  id: number
  text: string
  saidBy: string | null
  context: string | null
  addedBy: string | null
  createdAt: string
  comments: QuoteComment[]
  /** Only the emoji somebody picked, in a fixed order. */
  reactions: QuoteReaction[]
  myReaction: string | null
}

export interface QuoteReaction {
  emoji: string
  count: number
}

/** A note passed to you. `from` is null when it was sent anonymously. */
export interface Note {
  id: number
  message: string
  from: { id: number | null; name: string } | null
  read: boolean
  createdAt: string
}

/** A message sent through the feedback button, as organizers see it. */
export interface FeedbackMessage {
  id: number
  message: string
  sender: string | null
  emailed: boolean
  createdAt: string
}

export interface Credit {
  name: string
  note?: string
}

export interface EventInfo {
  title: string
  tagline: string
  school: string
  date: string
  venue: { name: string; address: string; mapUrl: string }
  about: string
  schedule: { time: string; title: string; detail: string }[]
  music: { youtubePlaylistId: string; mixtapeTitle: string }
  memories: { albumTitle: string; blurb: string; albumUrl: string }
  videos: { title: string; url: string; note?: string }[]
  /** Whoever helped build the site or fill it with material. Edited by the organizers, kept in the database. */
  credits?: Credit[]
  visits: number
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const TOKEN_KEY = 'reunion.editToken'

export const editToken = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set: (token: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      /* private mode: the edit link still works */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  },
}

const REACTOR_KEY = 'reunion.reactor'

/** A random key this browser keeps, so a visitor without a profile still reacts once and can take it back. */
function reactorKey(): string | null {
  try {
    let key = localStorage.getItem(REACTOR_KEY)
    if (!key) localStorage.setItem(REACTOR_KEY, (key = crypto.randomUUID()))
    return key
  } catch {
    return null
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = editToken.get()
  if (token) headers['x-edit-token'] = token
  const reactor = path.startsWith('/api/quotes') ? reactorKey() : null
  if (reactor) headers['x-reactor'] = reactor
  if (init.json !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, {
    method: init.method ?? (init.json !== undefined || init.body ? 'POST' : 'GET'),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'משהו השתבש')
  return data as T
}

export function faceUrl(tag: Tag): string {
  return `/api/tags/${tag.id}/face?v=${[tag.x, tag.y, tag.w, tag.h].map(Math.round).join('-')}`
}

/** Case- and accent-insensitive match across the names someone might search for (works for Hebrew too). */
export function matchesPerson(person: Person, query: string): boolean {
  const norm = (s: string) => s.normalize('NFKD').replace(/[̀-֑ͯ-ׇ]/g, '').toLowerCase()
  const haystack = norm([person.name, person.formerName, person.nickname].filter(Boolean).join(' '))
  return norm(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}
