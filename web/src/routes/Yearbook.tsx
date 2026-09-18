import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { faceUrl, matchesPerson, type Person, type Scene, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import SceneViewer from '../components/SceneViewer.tsx'
import { PersonPanel, UnknownPanel } from '../components/PersonPanel.tsx'

function SearchBox({ onPick }: { onPick: (person: Person) => void }) {
  const { people, scenes } = useStore()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const results = useMemo(
    () => (query.trim() ? people.filter((p) => matchesPerson(p, query)).slice(0, 8) : []),
    [people, query],
  )
  const thumb = (p: Person) => {
    if (p.thenPhoto) return p.thenPhoto
    for (const scene of [...scenes].reverse()) {
      const tag = scene.kind === 'group' && scene.tags.find((t) => t.personId === p.id)
      if (tag) return faceUrl(tag)
    }
    return null
  }

  return (
    <div className="relative w-full sm:w-80">
      <input
        className="field shadow-chunk"
        type="search"
        dir="auto"
        placeholder={`Find a classmate (${people.length} so far)`}
        value={query}
        onChange={(e) => (setQuery(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) (onPick(results[0]), setOpen(false))
          if (e.key === 'Escape') setOpen(false)
        }}
        aria-label="Search classmates by name"
      />
      {open && query.trim() && (
        <ul className="chunk absolute inset-x-0 top-full mt-2 max-h-80 overflow-y-auto p-1">
          {results.length === 0 && <li className="p-3 text-sm">Nobody by that name yet. Find their face and add them!</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-start hover:bg-sun"
                onClick={() => (onPick(p), setOpen(false), setQuery(''))}
              >
                {thumb(p) ? (
                  <img src={thumb(p)!} alt="" className="h-10 w-10 rounded border-2 border-ink object-cover" loading="lazy" />
                ) : (
                  <span className="h-10 w-10 rounded border-2 border-ink bg-paper" />
                )}
                <span className="min-w-0">
                  <span className="block truncate font-bold" dir="auto">
                    {p.name}
                  </span>
                  <span className="block truncate text-xs opacity-70" dir="auto">
                    {[p.formerName && `formerly ${p.formerName}`, p.city].filter(Boolean).join(' - ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function Yearbook() {
  const { scenes, role, me, personById } = useStore()
  const navigate = useNavigate()
  const params = useParams()
  const [search] = useSearchParams()
  const personId = params.personId ? Number(params.personId) : null
  const person = personById(personId)

  const sceneFromUrl = scenes.find((s) => s.slug === search.get('s'))
  const [sceneId, setSceneId] = useState<number | null>(null)
  const scene: Scene | undefined = sceneFromUrl ?? scenes.find((s) => s.id === sceneId) ?? scenes.findLast((s) => s.kind === 'group') ?? scenes[0]

  const [unknownTag, setUnknownTag] = useState<Tag | null>(null)
  const [focus, setFocus] = useState<{ tagId: number; nonce: number } | null>(null)

  const go = (target: { personId?: number | null; scene?: Scene }) => {
    const slug = (target.scene ?? scene)?.slug
    navigate(`${target.personId ? `/p/${target.personId}` : '/'}${slug ? `?s=${slug}` : ''}`)
  }

  // Deep link or search result: make sure we are on a scene that shows this person, then fly to them.
  const personTag = person && scene?.tags.find((t) => t.personId === person.id)
  useEffect(() => {
    if (!person || !scene) return
    if (personTag) return setFocus({ tagId: personTag.id, nonce: Date.now() })
    const other = scenes.find((s) => s.tags.some((t) => t.personId === person.id))
    if (other) go({ personId: person.id, scene: other })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id, scene?.id, personTag?.id])

  useEffect(() => {
    if (scene) setSceneId(scene.id)
    setUnknownTag((tag) => (tag && tag.sceneId !== scene?.id ? null : tag))
  }, [scene])

  if (!scene) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="chunk space-y-3 p-6">
          <h1 className="heading">No pictures yet</h1>
          <p>The yearbook is empty. An organizer needs to upload the class photos first.</p>
          {role === 'admin' && (
            <Link className="btn btn-pink" to="/admin">
              Go to the admin page
            </Link>
          )}
        </div>
      </div>
    )
  }

  const selectedTagId = unknownTag?.id ?? personTag?.id ?? null
  const named = scene.tags.filter((t) => t.personId != null).length

  return (
    <div className="absolute inset-0">
      <SceneViewer
        key={scene.dzi}
        scene={scene}
        labelFor={(tag) => personById(tag.personId)?.name ?? null}
        selectedTagId={selectedTagId}
        myPersonId={me?.id ?? null}
        focus={focus}
        onSelect={(tag) => {
          if (tag.personId != null) {
            setUnknownTag(null)
            go({ personId: tag.personId })
          } else {
            setUnknownTag(tag)
            setFocus({ tagId: tag.id, nonce: Date.now() })
            if (personId) go({})
          }
        }}
        onBackgroundClick={() => {
          setUnknownTag(null)
          if (personId) go({})
        }}
      />

      <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-col gap-2 sm:inset-x-3 sm:top-3 sm:flex-row sm:items-start [&>*]:pointer-events-auto">
        <SearchBox onPick={(p) => (setUnknownTag(null), go({ personId: p.id }))} />
        <div className="flex gap-2 overflow-x-auto pb-1">
          {scenes.map((s) => (
            <button
              key={s.id}
              dir="auto"
              onClick={() => (setUnknownTag(null), go({ personId: person && s.tags.some((t) => t.personId === person.id) ? person.id : null, scene: s }))}
              className={`btn btn-sm marker shrink-0 whitespace-nowrap ${s.id === scene.id ? 'btn-pink' : 'btn-plain'}`}
            >
              {s.title}
            </button>
          ))}
        </div>
        {scene.kind === 'group' && scene.tags.length > 0 && (
          <span className="lcd hidden shrink-0 text-lg sm:ms-auto sm:me-24 sm:block">
            {named}/{scene.tags.length} NAMED
          </span>
        )}
      </div>

      {unknownTag ? (
        <UnknownPanel
          key={unknownTag.id}
          tag={unknownTag}
          onClose={() => setUnknownTag(null)}
          onNamed={(id) => (setUnknownTag(null), go({ personId: id }))}
        />
      ) : person ? (
        <PersonPanel key={person.id} person={person} onClose={() => go({})} onJump={(s) => go({ personId: person.id, scene: s })} />
      ) : null}
    </div>
  )
}
