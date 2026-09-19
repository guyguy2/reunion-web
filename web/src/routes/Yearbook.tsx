import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { faceUrl, matchesPerson, type Person, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import { PersonPanel, UnknownPanel } from '../components/PersonPanel.tsx'
import { tilePhoto, unknownFaces } from '../yearbook.ts'

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
      {sub && <span className="block truncate text-xs opacity-70">{sub}</span>}
    </button>
  )
}

/** The yearbook: everyone as a photo tile, then the faces still waiting for a name. Same layout on phones and desktops. */
export default function Yearbook() {
  const { people, scenes, role, me, personById } = useStore()
  const navigate = useNavigate()
  const params = useParams()
  const person = personById(params.personId ? Number(params.personId) : null)
  const [query, setQuery] = useState('')
  const [unknownTag, setUnknownTag] = useState<Tag | null>(null)

  const shown = query.trim() ? people.filter((p) => matchesPerson(p, query)) : people
  const unknown = unknownFaces(scenes)
  const open = (p: Person) => (setUnknownTag(null), navigate(`/p/${p.id}`))

  if (people.length === 0 && unknown.length === 0) {
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

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="heading">ספר המחזור</h1>
        <input
          className="field max-w-xs shadow-chunk"
          type="search"
          dir="auto"
          placeholder={`חיפוש לפי שם (${people.length})`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="חיפוש בוגרים לפי שם"
        />
      </div>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {shown.map((p) => (
          <Tile key={p.id} src={tilePhoto(p, scenes)} label={p.name} sub={p.inMemoriam ? 'ז״ל' : undefined} highlight={p.id === me?.id} onClick={() => open(p)} />
        ))}
      </div>
      {shown.length === 0 && <p className="text-center">אין מישהו בשם הזה. אולי מחכים למטה, בין הפנים בלי שם?</p>}

      {!query.trim() && unknown.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-xl">מי זה? ({unknown.length} בלי שם)</h2>
          <p className="text-sm">מזהים מישהו? לחצו על התמונה והוסיפו שם. זה אתם? אפשר לקחת את הפרופיל.</p>
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 md:grid-cols-8">
            {unknown.map((tag) => (
              <Tile key={tag.id} src={faceUrl(tag)} label="?" onClick={() => setUnknownTag(tag)} />
            ))}
          </div>
        </section>
      )}

      {unknownTag ? (
        <UnknownPanel key={unknownTag.id} tag={unknownTag} onClose={() => setUnknownTag(null)} onNamed={(id) => (setUnknownTag(null), navigate(`/p/${id}`))} />
      ) : person ? (
        <PersonPanel key={person.id} person={person} onClose={() => navigate('/')} />
      ) : null}
    </div>
  )
}
