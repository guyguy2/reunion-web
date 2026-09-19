import { Fragment, lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api, type Role } from './api.ts'
import { StoreProvider, useStore } from './store.tsx'
import Gate from './components/Gate.tsx'
import Cassette from './components/Cassette.tsx'
import Feedback from './components/Feedback.tsx'
import { RsvpShortcut } from './components/Rsvp.tsx'
import Yearbook from './routes/Yearbook.tsx'
import YearbookGrid from './routes/YearbookGrid.tsx'
import Welcome from './components/Welcome.tsx'
import Videos from './routes/Videos.tsx'
import Memories from './routes/Memories.tsx'
import Quotes from './routes/Quotes.tsx'
import EventPage from './routes/EventPage.tsx'
import Me from './routes/Me.tsx'
import { SignInFromLink } from './components/CodeLogin.tsx'

const Admin = lazy(() => import('./routes/Admin.tsx'))

// Each tab is a VHS tape spine: a white label with a colored stripe, filled with its color on the current page.
// The event and the profile are not tabs: the RSVP shortcut and the profile button live beside them.
const TABS = [
  { to: '/', label: 'ספר מחזור', spine: 'var(--color-pink)', fill: 'bg-pink text-ink' },
  { to: '/memories', label: 'זכרונות', spine: 'var(--color-teal)', fill: 'bg-teal text-ink' },
  { to: '/videos', label: 'סרטונים', spine: 'var(--color-grape)', fill: 'bg-violet-600 text-white' },
  { to: '/quotes', label: 'ציטוטים', spine: 'var(--color-tangerine)', fill: 'bg-tangerine text-ink' },
]
const ADMIN_TAB = { to: '/admin', label: 'חדר המנהל', spine: 'var(--color-ink)', fill: 'bg-ink text-white' }

function Shell() {
  const { event, role, loading, unreadNotes } = useStore()
  const tabs = role === 'admin' ? [...TABS, ADMIN_TAB] : TABS

  useEffect(() => {
    if (event?.title) document.title = event.title
  }, [event?.title])

  return (
    <div className="flex h-full flex-col">
      <header className="z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b-[3px] border-ink bg-white px-4 py-2 sm:gap-x-6">
        <NavLink to="/" className="flex items-center gap-2 font-display text-lg leading-none tracking-wide sm:text-2xl" style={{ textShadow: '2px 2px 0 var(--color-sun)' }}>
          <img src="/hadassim-emblem.png" alt="" width={70} height={64} className="h-8 w-auto sm:h-10" />
          {event?.title ?? 'פגישת מחזור'}
        </NavLink>
        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t-[3px] border-ink bg-white sm:static sm:gap-2 sm:border-0 sm:bg-transparent">
          {tabs.map((tab, i) => (
            <Fragment key={tab.to}>
              {/* On phones the RSVP shortcut takes the middle of the bottom bar. */}
              {i === 2 && <RsvpShortcut variant="bar" />}
              <NavLink
                to={tab.to}
                end={tab.to === '/'}
                style={{ '--spine': tab.spine } as CSSProperties}
                className={({ isActive }) =>
                  `marker flex-1 border-ink px-1 py-3.5 text-center text-sm leading-none whitespace-nowrap sm:flex-none sm:rounded-md sm:border-[3px] sm:px-3 sm:pt-1.5 sm:pb-2.5 sm:text-lg ${
                    isActive
                      ? `${tab.fill} shadow-[inset_0_-4px_0_var(--color-ink)] sm:-translate-y-0.5 sm:shadow-chunk`
                      : 'bg-white text-ink shadow-[inset_0_5px_0_var(--spine)] hover:bg-paper sm:shadow-[inset_0_-6px_0_var(--spine)]'
                  }`
                }
              >
                {tab.label}
              </NavLink>
            </Fragment>
          ))}
        </nav>
        <span className="hidden sm:ms-auto sm:block">
          <RsvpShortcut variant="header" />
        </span>
        <NavLink
          to="/me"
          className={({ isActive }) =>
            `ms-auto flex items-center gap-1.5 rounded-full border-[3px] border-ink bg-sky p-1 text-sm font-bold whitespace-nowrap sm:ms-0 sm:px-3 sm:py-0.5 ${isActive ? 'shadow-chunk' : ''}`
          }
        >
          <svg viewBox="0 0 24 24" className="size-4 fill-ink sm:hidden" aria-hidden="true">
            <circle cx="12" cy="8" r="4.5" />
            <path d="M3 22c0-5 4-8 9-8s9 3 9 8z" />
          </svg>
          <span className="sr-only sm:not-sr-only">הפרופיל שלי</span>
          {unreadNotes > 0 && (
            <span className="inline-block rounded-full border-2 border-ink bg-pink px-1.5 font-sans text-xs font-bold text-white" aria-label={`${unreadNotes} פתקים חדשים`}>
              {unreadNotes}
            </span>
          )}
        </NavLink>
        <Feedback />
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
              <Route path="/friends" element={<YearbookGrid />} />
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
      <Welcome />
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
