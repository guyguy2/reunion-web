import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { api, ApiError, editToken, type EventInfo, type Person, type Role, type Scene } from './api.ts'

interface Store {
  role: Role
  people: Person[]
  scenes: Scene[]
  event: EventInfo | null
  /** Replaces the event details after an organizer edits them, so every screen shows what the server now has. */
  setEvent: Dispatch<SetStateAction<EventInfo | null>>
  me: Person | null
  /** Unread notes for "me", kept apart from `me` so opening a note doesn't reset the profile form. */
  unreadNotes: number
  setUnreadNotes: (n: number) => void
  loading: boolean
  reload: () => Promise<void>
  /**
   * Checks a new edit token (after claiming, signing in or opening an edit link), and only then stores it and
   * refreshes "me". When it doesn't check out it throws, and whatever token this device already had stays.
   */
  adoptToken: (token: string) => Promise<Person>
  forgetMe: () => void
  personById: (id: number | null | undefined) => Person | undefined
}

const StoreContext = createContext<Store | null>(null)

/**
 * Asks the server whose profile a new edit token opens, sending that token alone, before anything is stored.
 * A token the server doesn't know throws an ApiError (403 or 404); a request that never got an answer throws an Error.
 */
export async function checkEditToken(token: string): Promise<Person> {
  let res: Response
  try {
    res = await fetch('/api/me', { headers: { 'x-edit-token': token }, credentials: 'same-origin' })
  } catch {
    throw new Error('אין חיבור לאתר כרגע. בדקו את האינטרנט ונסו שוב.')
  }
  const data = (await res.json().catch(() => null)) as (Person & { error?: string }) | null
  if (res.status === 403 || res.status === 404) throw new ApiError(res.status, 'קישור העריכה כבר לא בתוקף. בקשו מאחד המארגנים לאפס את הפרופיל.')
  if (!res.ok || !data) throw new ApiError(res.status, data?.error ?? 'משהו השתבש. נסו שוב.')
  return data
}

/** Checks a new edit token and only then stores it, so when the check throws, the token this device already had stays. */
export async function adoptEditToken(token: string): Promise<Person> {
  const person = await checkEditToken(token)
  editToken.set(token)
  return person
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside StoreProvider')
  return store
}

export function StoreProvider({ role, children }: { role: Role; children: ReactNode }) {
  const [people, setPeople] = useState<Person[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [event, setEvent] = useState<EventInfo | null>(null)
  const [me, setMe] = useState<Person | null>(null)
  const [unreadNotes, setUnreadNotes] = useState(0)
  const [loading, setLoading] = useState(true)

  const loadMe = useCallback(async () => {
    if (!editToken.get()) return setMe(null), null
    try {
      const person = await api<Person>('/api/me')
      setMe(person)
      setUnreadNotes(person.unreadNotes ?? 0)
      return person
    } catch {
      setMe(null)
      return null
    }
  }, [])

  const reload = useCallback(async () => {
    const [nextPeople, nextScenes] = await Promise.all([api<Person[]>('/api/people'), api<Scene[]>('/api/scenes'), loadMe()])
    setPeople(nextPeople)
    setScenes(nextScenes)
  }, [loadMe])

  useEffect(() => {
    Promise.all([reload(), api<EventInfo>('/api/event').then(setEvent)]).finally(() => setLoading(false))
  }, [reload])

  const store = useMemo<Store>(() => {
    const index = new Map(people.map((p) => [p.id, p]))
    return {
      role,
      people,
      scenes,
      event,
      setEvent,
      me,
      unreadNotes: me ? unreadNotes : 0,
      setUnreadNotes,
      loading,
      reload,
      adoptToken: async (token) => {
        const person = await adoptEditToken(token)
        setMe(person)
        setUnreadNotes(person.unreadNotes ?? 0)
        return person
      },
      forgetMe: () => {
        editToken.clear()
        setMe(null)
      },
      personById: (id) => (id == null ? undefined : index.get(id)),
    }
  }, [role, people, scenes, event, me, unreadNotes, loading, reload])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
