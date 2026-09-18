import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, editToken, type EventInfo, type Person, type Role, type Scene } from './api.ts'

interface Store {
  role: Role
  people: Person[]
  scenes: Scene[]
  event: EventInfo | null
  me: Person | null
  loading: boolean
  reload: () => Promise<void>
  /** Stores a new edit token (after claiming or opening an edit link) and refreshes "me". */
  adoptToken: (token: string) => Promise<Person | null>
  forgetMe: () => void
  personById: (id: number | null | undefined) => Person | undefined
}

const StoreContext = createContext<Store | null>(null)

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
  const [loading, setLoading] = useState(true)

  const loadMe = useCallback(async () => {
    if (!editToken.get()) return setMe(null), null
    try {
      const person = await api<Person>('/api/me')
      setMe(person)
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
      me,
      loading,
      reload,
      adoptToken: async (token) => {
        editToken.set(token)
        const person = await loadMe()
        if (!person) editToken.clear()
        return person
      },
      forgetMe: () => {
        editToken.clear()
        setMe(null)
      },
      personById: (id) => (id == null ? undefined : index.get(id)),
    }
  }, [role, people, scenes, event, me, loading, reload, loadMe])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}
