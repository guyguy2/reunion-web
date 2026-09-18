import { createElement, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import 'img-comparison-slider'
import { api, faceUrl, matchesPerson, type Person, type Scene, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'

const ATTENDING = {
  yes: { text: "I'll be there!", className: 'bg-teal text-white' },
  maybe: { text: 'Maybe...', className: 'bg-sun text-ink' },
  no: { text: "Can't make it", className: 'bg-white text-ink' },
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <section className="chunk absolute inset-x-2 bottom-16 z-10 max-h-[62%] overflow-y-auto p-4 shadow-chunk-lg sm:inset-x-auto sm:top-3 sm:right-16 sm:bottom-3 sm:max-h-none sm:w-96">
      <button className="btn btn-plain btn-sm pixel absolute top-2 right-2 text-lg leading-none" onClick={onClose} aria-label="Close">
        X
      </button>
      {children}
    </section>
  )
}

/** Every appearance of this person on the class photos, oldest first. */
export function appearances(scenes: Scene[], personId: number): { scene: Scene; tag: Tag }[] {
  return scenes
    .filter((s) => s.kind === 'group')
    .flatMap((scene) => scene.tags.filter((t) => t.personId === personId).slice(0, 1).map((tag) => ({ scene, tag })))
}

export function PersonPanel({ person, onClose, onJump }: { person: Person; onClose: () => void; onJump: (scene: Scene) => void }) {
  const { scenes, me, adoptToken, reload } = useStore()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const faces = appearances(scenes, person.id)
  const thenSrc = person.thenPhoto ?? (faces.length ? faceUrl(faces[faces.length - 1].tag) : null)
  const isMe = me?.id === person.id

  async function claim() {
    setError('')
    try {
      const { token } = await api<{ token: string }>(`/api/people/${person.id}/claim`, { method: 'POST' })
      await adoptToken(token)
      await reload()
      navigate('/me?welcome=1')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Drawer onClose={onClose}>
      <div className="flex items-start gap-4 pr-10">
        {(person.nowPhoto ?? thenSrc) && (
          <div className="polaroid w-28 shrink-0 -rotate-3 pb-2">
            <img src={(person.nowPhoto ?? thenSrc)!} alt="" className="aspect-[4/5] w-full object-cover" />
          </div>
        )}
        <div className="min-w-0">
          <h2 className="font-display text-2xl leading-tight break-words" dir="auto">
            {person.name}
          </h2>
          {person.formerName && (
            <p className="text-sm opacity-70" dir="auto">
              formerly {person.formerName}
            </p>
          )}
          {person.nickname && (
            <p className="marker text-lg" dir="auto">
              "{person.nickname}"
            </p>
          )}
          {person.city && (
            <p className="mt-1 text-sm font-bold" dir="auto">
              {person.city}
            </p>
          )}
          {person.inMemoriam && <p className="mt-1 text-sm font-bold">In loving memory</p>}
        </div>
      </div>

      {person.attending && (
        <p className={`marker mt-4 inline-block rotate-1 border-[3px] border-ink px-3 py-1 ${ATTENDING[person.attending].className}`}>
          {ATTENDING[person.attending].text}
        </p>
      )}

      {person.quote && (
        <blockquote className="marker mt-4 border-l-[6px] border-pink pl-3 text-lg" dir="auto">
          {person.quote}
        </blockquote>
      )}
      {person.bio && (
        <p className="mt-3 whitespace-pre-line" dir="auto">
          {person.bio}
        </p>
      )}

      {(person.email || person.instagram || person.linkedin) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {person.email && (
            <a className="btn btn-plain btn-sm" href={`mailto:${person.email}`}>
              Email
            </a>
          )}
          {person.instagram && (
            <a className="btn btn-pink btn-sm" href={`https://instagram.com/${person.instagram}`} target="_blank" rel="noreferrer">
              @{person.instagram}
            </a>
          )}
          {person.linkedin && (
            <a className="btn btn-teal btn-sm" href={person.linkedin} target="_blank" rel="noreferrer">
              LinkedIn
            </a>
          )}
        </div>
      )}

      {thenSrc && person.nowPhoto && (
        <div className="mt-5">
          <h3 className="label">Then / now</h3>
          <div className="border-[3px] border-ink">
            {createElement(
              'img-comparison-slider',
              { class: 'block w-full' },
              <img slot="first" src={thenSrc} alt="Then" className="aspect-[4/5] w-full object-cover" />,
              <img slot="second" src={person.nowPhoto} alt="Now" className="aspect-[4/5] w-full object-cover" />,
            )}
          </div>
        </div>
      )}

      {faces.length > 0 && (
        <div className="mt-5">
          <h3 className="label">Through the years</h3>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {faces.map(({ scene, tag }) => (
              <button key={tag.id} onClick={() => onJump(scene)} className="polaroid w-24 shrink-0 cursor-pointer pb-1 text-center hover:-translate-y-0.5">
                <img src={faceUrl(tag)} alt="" className="aspect-square w-full object-cover" loading="lazy" />
                <span className="marker block pt-1 text-xs leading-tight" dir="auto">
                  {scene.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {isMe ? (
          <button className="btn btn-teal w-full" onClick={() => navigate('/me')}>
            This is you. Edit your profile
          </button>
        ) : !person.claimed && !person.inMemoriam && !me ? (
          <button className="btn btn-pink w-full" onClick={claim}>
            This is me! Claim this profile
          </button>
        ) : null}
        {!person.claimed && !isMe && <p className="text-sm opacity-70">Nobody has claimed this profile yet.</p>}
        {error && <p className="font-bold text-pink">{error}</p>}
      </div>
    </Drawer>
  )
}

/** Shown for a face nobody has named yet. Naming it creates (or links) a profile in one step. */
export function UnknownPanel({ tag, onClose, onNamed }: { tag: Tag; onClose: () => void; onNamed: (personId: number) => void }) {
  const { people, scenes, me, adoptToken, reload } = useStore()
  const [mode, setMode] = useState<'me' | 'other' | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const scene = scenes.find((s) => s.id === tag.sceneId)
  const taken = new Set(scene?.tags.map((t) => t.personId))
  const matches = name.trim().length > 1 ? people.filter((p) => matchesPerson(p, name) && !taken.has(p.id)).slice(0, 5) : []

  async function run(action: () => Promise<number>) {
    setBusy(true)
    setError('')
    try {
      const personId = await action()
      await reload()
      onNamed(personId)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const thatsMeExisting = () =>
    run(async () => {
      await api(`/api/tags/${tag.id}/identify`, { method: 'POST' })
      return me!.id
    })

  const thatsMeNew = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const { token, person } = await api<{ token: string; person: Person }>('/api/people', { json: { name } })
      await adoptToken(token)
      await api(`/api/tags/${tag.id}/identify`, { method: 'POST' })
      return person.id
    })
  }

  const suggest = (body: { name: string } | { personId: number }) =>
    run(async () => (await api<{ personId: number }>(`/api/tags/${tag.id}/suggest`, { json: body })).personId)

  return (
    <Drawer onClose={onClose}>
      <div className="flex items-center gap-4 pr-10">
        <div className="polaroid w-28 shrink-0 rotate-2 pb-2">
          <img src={faceUrl(tag)} alt="" className="aspect-square w-full object-cover" />
        </div>
        <div className="sticky-note text-xl">Who dis?</div>
      </div>
      <p className="mt-4">Nobody has put a name to this face yet. Help fill in the yearbook:</p>

      <div className="mt-3 flex gap-2">
        {me ? (
          <button className="btn btn-pink flex-1" disabled={busy} onClick={thatsMeExisting}>
            That's me!
          </button>
        ) : (
          <button className={`btn flex-1 ${mode === 'me' ? 'btn-pink' : 'btn-plain'}`} onClick={() => setMode('me')}>
            That's me!
          </button>
        )}
        <button className={`btn flex-1 ${mode === 'other' ? 'btn-teal' : 'btn-plain'}`} onClick={() => setMode('other')}>
          I know who this is
        </button>
      </div>

      {mode && !(mode === 'me' && me) && (
        <form className="mt-4 space-y-2" onSubmit={mode === 'me' ? thatsMeNew : (e) => (e.preventDefault(), suggest({ name }))}>
          <label className="label" htmlFor="face-name">
            {mode === 'me' ? 'Your name' : 'Their name'}
          </label>
          <input id="face-name" className="field" dir="auto" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          {matches.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-bold">Already in the yearbook? Pick them:</p>
              {matches.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  dir="auto"
                  className="btn btn-plain btn-sm w-full justify-start"
                  disabled={busy || (mode === 'me' && p.claimed)}
                  onClick={() =>
                    mode === 'other'
                      ? suggest({ personId: p.id })
                      : run(async () => {
                          const { token } = await api<{ token: string }>(`/api/people/${p.id}/claim`, { method: 'POST' })
                          await adoptToken(token)
                          await api(`/api/tags/${tag.id}/identify`, { method: 'POST' })
                          return p.id
                        })
                  }
                >
                  {p.name}
                  {mode === 'me' && p.claimed ? ' (already claimed)' : ''}
                </button>
              ))}
            </div>
          )}
          <button className="btn w-full" disabled={busy || name.trim().length < 2}>
            {mode === 'me' ? 'Create my profile' : 'Add this name'}
          </button>
        </form>
      )}
      {error && <p className="mt-3 font-bold text-pink">{error}</p>}
    </Drawer>
  )
}
