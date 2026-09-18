export type Role = 'member' | 'admin'

export interface Person {
  id: number
  name: string
  formerName: string | null
  nickname: string | null
  email: string | null
  instagram: string | null
  linkedin: string | null
  city: string | null
  bio: string | null
  quote: string | null
  thenPhoto: string | null
  nowPhoto: string | null
  attending: 'yes' | 'no' | 'maybe' | null
  inMemoriam: boolean
  claimed: boolean
  showEmail?: boolean
  showInstagram?: boolean
  showLinkedin?: boolean
}

export interface Tag {
  id: number
  sceneId: number
  personId: number | null
  x: number
  y: number
  w: number
  h: number
}

export interface Scene {
  id: number
  slug: string
  title: string
  kind: 'mosaic' | 'group'
  width: number
  height: number
  dzi: string
  tags: Tag[]
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

export async function api<T = unknown>(path: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = editToken.get()
  if (token) headers['x-edit-token'] = token
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
