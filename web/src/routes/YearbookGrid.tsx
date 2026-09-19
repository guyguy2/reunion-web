import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { faceUrl, matchesPerson, type Person, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import FriendFilters, { useFilters } from '../components/FriendFilters.tsx'
import { PersonPanel, UnknownPanel } from '../components/PersonPanel.tsx'
import { filterPeople, isFiltering, tilePhoto, unknownFaces, type Appearance } from '../yearbook.ts'

function Tile({ src, label, sub, highlight, onClick }: { src: string | null; label: string; sub?: string; highlight?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`polaroid cursor-pointer pb-2 text-center transition-transform hover:-translate-y-0.5 ${highlight ? 'bg-sun' : ''}`}>
      {src ? (
        <img src={src} alt="" className="aspect-square w-full object-cover" loading="lazy" />
      ) : (
        <span className="font-display flex aspect-square w-full items-center justify-center bg-paper text-4xl">{label.slice(0, 1)}</span>
      )}
      <span className="marker mt-1 block truncate text-sm leading-tight" dir="auto">
        {label}
      </span>
      {sub && (
        <span className="block truncate text-xs opacity-70" dir="auto">
          {sub}
        </span>
      )}
    </button>
  )
}

const classTitle = (a: Appearance | undefined) => (a?.classLabel ? [a.year, a.classLabel].filter(Boolean).join(' · ') : 'בלי כיתה')

/**
 * Everyone as a photo tile, with search and filters, then the faces still waiting for a name. It is the whole yearbook
 * on phones (no big class photos to download) and the "find friends" page everywhere else.
 */
export default function YearbookGrid() {
  const { people, scenes, role, me, personById } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const [filters, setFilters] = useFilters()
  const [unknownTag, setUnknownTag] = useState<Tag | null>(null)
  // On a big screen this page sits beside the zoomable photos, so a profile opens in place instead of at /p/:id.
  const standalone = location.pathname.startsWith('/friends')
  const [openId, setOpenId] = useState<number | null>(null)
  const person = personById(standalone ? openId : params.personId ? Number(params.personId) : null)

  const rows = useMemo(() => filterPeople(people, scenes, filters, matchesPerson), [people, scenes, filters])
  const narrowed = filters.year != null || filters.classLabel != null
  const unknown = unknownFaces(scenes).filter((tag) => {
    const scene = scenes.find((s) => s.id === tag.sceneId)
    return (filters.year == null || scene?.year === filters.year) && (filters.classLabel == null || tag.classLabel === filters.classLabel)
  })
  const showUnknown = !filters.query.trim() && !filters.gender && unknown.length > 0

  const go = (pathname: string) => navigate({ pathname, search: location.search })
  const open = (p: Person) => (setUnknownTag(null), standalone ? setOpenId(p.id) : go(`/p/${p.id}`))
  const close = () => (standalone ? setOpenId(null) : go('/'))

  if (people.length === 0 && unknownFaces(scenes).length === 0) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="chunk space-y-3 p-6">
          <h1 className="heading">ספר המחזור ריק</h1>
          <p>המארגנים צריכים להעלות קודם את תמונות המחזור.</p>
          {role === 'admin' && (
            <Link className="btn btn-pink" to="/admin">
              לעמוד הניהול
            </Link>
          )}
        </div>
      </div>
    )
  }

  const tile = ({ person: p, appearance }: (typeof rows)[number]) => (
    <Tile
      key={p.id}
      // Asked for a year or a class? Then the face from that poster, not the usual tile photo.
      src={narrowed && appearance ? faceUrl(appearance.tag) : tilePhoto(p, scenes)}
      label={p.name}
      sub={p.inMemoriam ? 'ז״ל' : filters.sort === 'class' ? undefined : (appearance?.classLabel ?? undefined)}
      highlight={p.id === me?.id}
      onClick={() => open(p)}
    />
  )
  const GRID = 'grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6'

  // Sorted by class, the grid is cut into one titled block per class.
  const groups: { title: string; rows: typeof rows }[] = []
  if (filters.sort === 'class') {
    for (const row of rows) {
      const title = classTitle(row.appearance)
      if (groups.at(-1)?.title === title) groups.at(-1)!.rows.push(row)
      else groups.push({ title, rows: [row] })
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 pb-28 sm:p-8 sm:pb-28">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="heading">{standalone ? 'חיפוש חברים' : 'ספר המחזור'}</h1>
        {standalone && (
          <Link to="/" className="btn btn-plain btn-sm">
            חזרה לתמונות המחזור
          </Link>
        )}
      </div>

      <div className="sticky top-0 z-10 -mx-4 bg-paper/95 px-4 py-2 backdrop-blur sm:-mx-8 sm:px-8">
        <FriendFilters scenes={scenes} filters={filters} onChange={setFilters} total={people.length} shown={rows.length} genders={people.some((p) => p.gender)} />
      </div>

      {filters.sort === 'class' ? (
        groups.map((group) => (
          <section key={group.title} className="space-y-2">
            <h2 className="font-display text-xl" dir="auto">
              {group.title} <span className="text-base opacity-70">({group.rows.length})</span>
            </h2>
            <div className={GRID}>{group.rows.map(tile)}</div>
          </section>
        ))
      ) : (
        <div className={GRID}>{rows.map(tile)}</div>
      )}
      {rows.length === 0 && isFiltering(filters) && (
        <p className="text-center">
          אין אף אחד שמתאים לסינון הזה.{' '}
          {showUnknown ? 'אולי מחכים למטה, בין הפנים בלי שם?' : 'נסו להוריד אחד מהמסננים.'}
        </p>
      )}

      {showUnknown && (
        <section className="space-y-3">
          <h2 className="font-display text-xl">מי זה? ({unknown.length} בלי שם)</h2>
          <p className="text-sm">מזהים מישהו? לחצו על התמונה והוסיפו שם. זה אתם? אפשר לקחת את הפרופיל.</p>
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 md:grid-cols-8">
            {unknown.map((tag) => (
              <Tile key={tag.id} src={faceUrl(tag)} label={tag.caption ?? '?'} onClick={() => setUnknownTag(tag)} />
            ))}
          </div>
        </section>
      )}

      {unknownTag ? (
        <UnknownPanel key={unknownTag.id} tag={unknownTag} onClose={() => setUnknownTag(null)} onNamed={(id) => (setUnknownTag(null), standalone ? setOpenId(id) : go(`/p/${id}`))} layout="sheet" />
      ) : person ? (
        <PersonPanel key={person.id} person={person} onClose={close} onJump={standalone ? (s) => navigate(`/p/${person.id}?s=${s.slug}`) : undefined} layout="sheet" />
      ) : null}
    </div>
  )
}
