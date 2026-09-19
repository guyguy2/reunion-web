import { lazy, Suspense, useEffect, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api, type Role } from './api.ts'
import { StoreProvider, useStore } from './store.tsx'
import Gate from './components/Gate.tsx'
import Cassette from './components/Cassette.tsx'
import Feedback from './components/Feedback.tsx'
import Yearbook from './routes/Yearbook.tsx'
import Videos from './routes/Videos.tsx'
import Memories from './routes/Memories.tsx'
import Quotes from './routes/Quotes.tsx'
import EventPage from './routes/EventPage.tsx'
import Me from './routes/Me.tsx'
import { SignInFromLink } from './components/CodeLogin.tsx'

const Admin = lazy(() => import('./routes/Admin.tsx'))

// Each tab is a VHS tape spine: a colored label with a handwritten title.
const TABS = [
  { to: '/', label: 'ספר מחזור', color: 'bg-pink text-white' },
  { to: '/videos', label: 'סרטונים', color: 'bg-grape text-white' },
  { to: '/memories', label: 'זכרונות', color: 'bg-teal text-white' },
  { to: '/quotes', label: 'ציטוטים', color: 'bg-tangerine text-ink' },
  { to: '/event', label: 'האירוע', color: 'bg-sun text-ink' },
  { to: '/me', label: 'הפרופיל שלי', color: 'bg-sky text-ink' },
]

function Shell() {
  const { event, role, loading, unreadNotes } = useStore()
  const tabs = role === 'admin' ? [...TABS, { to: '/admin', label: 'חדר המנהל', color: 'bg-ink text-white' }] : TABS

  useEffect(() => {
    if (event?.title) document.title = event.title
  }, [event?.title])

  return (
    <div className="flex h-full flex-col">
      <header className="z-20 flex flex-wrap items-center gap-x-6 gap-y-2 border-b-[3px] border-ink bg-white px-4 py-2">
        <NavLink to="/" className="font-display text-xl leading-none tracking-wide sm:text-2xl" style={{ textShadow: '2px 2px 0 var(--color-sun)' }}>
          {event?.title ?? 'פגישת מחזור'}
        </NavLink>
        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t-[3px] border-ink bg-white sm:static sm:gap-2 sm:border-0 sm:bg-transparent">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                `marker flex-1 border-ink px-1 py-3 text-center text-[13px] leading-none whitespace-nowrap sm:flex-none sm:rounded-md sm:border-[3px] sm:px-3 sm:py-1.5 sm:text-base ${tab.color} ${
                  isActive ? 'sm:shadow-chunk underline decoration-[3px] underline-offset-4 sm:-translate-y-0.5 sm:no-underline' : 'opacity-80 hover:opacity-100'
                }`
              }
            >
              {tab.label}
              {tab.to === '/me' && unreadNotes > 0 && (
                <span className="ms-1 inline-block rounded-full border-2 border-ink bg-pink px-1.5 font-sans text-xs font-bold text-white" aria-label={`${unreadNotes} פתקים חדשים`}>
                  {unreadNotes}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <span className="ms-auto">
          <Feedback />
        </span>
        <button
          className="cursor-pointer text-sm font-bold underline decoration-2 underline-offset-2 opacity-70 hover:opacity-100"
          onClick={() => api('/api/logout', { method: 'POST' }).then(() => location.assign('/'))}
        >
          התנתקות
        </button>
      </header>

      <main className="relative min-h-0 flex-1 overflow-y-auto pb-14 sm:pb-0">
        {loading ? (
          <p className="pixel p-10 text-center text-2xl">מחזירים את הקלטת להתחלה...</p>
        ) : (
          <Suspense fallback={<p className="pixel p-10 text-center text-2xl">טוען...</p>}>
            <Routes>
              <Route path="/" element={<Yearbook />} />
              <Route path="/p/:personId" element={<Yearbook />} />
              <Route path="/videos" element={<Videos />} />
              <Route path="/memories" element={<Memories />} />
              <Route path="/quotes" element={<Quotes />} />
              <Route path="/event" element={<EventPage />} />
              <Route path="/me" element={<Me />} />
              <Route path="/me/:token" element={<Me />} />
              <Route path="/signin/:token" element={<SignInFromLink />} />
              <Route path="/admin" element={role === 'admin' ? <Admin /> : <Yearbook />} />
              <Route path="*" element={<Yearbook />} />
            </Routes>
          </Suspense>
        )}
      </main>

      {/* Mounted outside the routes so the music keeps playing while people browse. */}
      <Cassette />
    </div>
  )
}

export default function App() {
  const [role, setRole] = useState<Role | null | undefined>(undefined)

  useEffect(() => {
    api<{ role: Role | null }>('/api/session')
      .then((s) => setRole(s.role))
      .catch(() => setRole(null))
  }, [])

  if (role === undefined) return null
  if (role === null) return <Gate onEnter={setRole} />
  return (
    <StoreProvider role={role}>
      <Shell />
    </StoreProvider>
  )
}
