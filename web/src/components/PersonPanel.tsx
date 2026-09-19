import { createElement, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import 'img-comparison-slider'
import { api, faceUrl, matchesPerson, type Person, type Scene, type Tag } from '../api.ts'
import { useStore } from '../store.tsx'
import ContactLinks from './ContactLinks.tsx'
import { NoteComposer } from './Notes.tsx'
import CodeLogin, { NewOwnerFields, newOwnerReady, type NewOwner } from './CodeLogin.tsx'
import { LAYER, useEscape } from '../useEscape.ts'

const ATTENDING = {
  yes: { text: 'אהיה שם!', className: 'bg-teal text-white' },
  maybe: { text: 'אולי...', className: 'bg-sun text-ink' },
  no: { text: 'לא אוכל להגיע', className: 'bg-white text-ink' },
}

/** "side": a panel beside the zoomable class photo (desktop). "sheet": a window over the phone grid. */
export type PanelLayout = 'side' | 'sheet'

export function Drawer({ onClose, layout, children }: { onClose: () => void; layout: PanelLayout; children: ReactNode }) {
  useEscape(onClose, LAYER.drawer)
  if (layout === 'side') {
    return (
      <section className="chunk absolute inset-x-2 bottom-16 z-10 max-h-[62%] overflow-y-auto p-4 shadow-chunk-lg sm:inset-x-auto sm:end-16 sm:top-3 sm:bottom-3 sm:max-h-none sm:w-96">
        <button className="btn btn-plain btn-sm pixel absolute end-2 top-2 text-lg leading-none" onClick={onClose} aria-label="סגירה">
          X
        </button>
        {children}
      </section>
    )
  }
  // A sheet from the bottom on phones, a centered window on wider screens. Clicking outside closes it.
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/50 sm:items-center sm:p-4" onClick={onClose}>
      <section
        className="chunk relative max-h-[88dvh] w-full overflow-y-auto rounded-b-none p-4 shadow-chunk-lg sm:max-w-md sm:rounded-b-xl"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="btn btn-plain btn-sm pixel absolute end-2 top-2 text-lg leading-none" onClick={onClose} aria-label="סגירה">
          X
        </button>
        {children}
      </section>
    </div>
  )
}

/** Every appearance of this person on the class photos, oldest first. */
export function appearances(scenes: Scene[], personId: number): { scene: Scene; tag: Tag }[] {
  return scenes
    .filter((s) => s.kind === 'group')
    .flatMap((scene) => scene.tags.filter((t) => t.personId === personId).slice(0, 1).map((tag) => ({ scene, tag })))
}

export function PersonPanel({ person, onClose, onJump, layout }: { person: Person; onClose: () => void; onJump?: (scene: Scene) => void; layout: PanelLayout }) {
  const { scenes, me, role, adoptToken, reload } = useStore()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [writing, setWriting] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [owner, setOwner] = useState<NewOwner>({ pin: '', email: '' })
  const faces = appearances(scenes, person.id)
  const thenSrc = person.thenPhoto ?? (faces.length ? faceUrl(faces[faces.length - 1].tag) : null)
  const isMe = me?.id === person.id
  // Owners can take their name off a wrongly tagged face; organizers can do it for anyone.
  const canUntag = isMe || role === 'admin'
  const [untagging, setUntagging] = useState<number | null>(null)

  /** Puts the face back to unnamed, so anyone can name it again. */
  async function untag(tag: Tag) {
    setUntagging(null)
    setError('')
    try {
      if (isMe) await api(`/api/tags/${tag.id}/identify`, { method: 'DELETE' })
      else await api(`/api/admin/tags/${tag.id}`, { method: 'PATCH', json: { personId: null } })
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function claim() {
    setError('')
    try {
      const { token } = await api<{ token: string }>(`/api/people/${person.id}/claim`, { json: owner })
      await adoptToken(token)
      await reload()
      navigate('/me?welcome=1')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Drawer onClose={onClose} layout={layout}>
      <div className="flex items-start gap-4 pe-10">
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
              לשעבר {person.formerName}
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
          {person.inMemoriam && <p className="mt-1 text-sm font-bold">נזכור תמיד</p>}
        </div>
      </div>

      {person.attending && (
        <p className={`marker mt-4 inline-block rotate-1 border-[3px] border-ink px-3 py-1 ${ATTENDING[person.attending].className}`}>
          {ATTENDING[person.attending].text}
        </p>
      )}

      {person.quote && (
        <blockquote className="marker mt-4 border-s-[6px] border-pink ps-3 text-lg" dir="auto">
          {person.quote}
        </blockquote>
      )}
      {person.bio && (
        <p className="mt-3 whitespace-pre-line" dir="auto">
          {person.bio}
        </p>
      )}

      <ContactLinks person={person} />

      {thenSrc && person.nowPhoto && (
        <div className="mt-5">
          <h3 className="label">אז / היום</h3>
          <div className="border-[3px] border-ink">
            {createElement(
              'img-comparison-slider',
              { class: 'block w-full' },
              <img slot="first" src={thenSrc} alt="אז" className="aspect-[4/5] w-full object-cover" />,
              <img slot="second" src={person.nowPhoto} alt="היום" className="aspect-[4/5] w-full object-cover" />,
            )}
          </div>
        </div>
      )}

      {faces.length > 0 && (
        <div className="mt-5">
          <h3 className="label">לאורך השנים</h3>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {faces.map(({ scene, tag }) => (
              <div key={tag.id} className="flex w-24 shrink-0 flex-col gap-1">
                <button
                  onClick={onJump && (() => onJump(scene))}
                  disabled={!onJump}
                  className="polaroid w-full pb-1 text-center enabled:cursor-pointer enabled:hover:-translate-y-0.5"
                >
                  <img src={faceUrl(tag)} alt="" className="aspect-square w-full object-cover" loading="lazy" />
                  <span className="marker block pt-1 text-xs leading-tight" dir="auto">
                    {scene.title}
                  </span>
                </button>
                {canUntag &&
                  (untagging === tag.id ? (
                    <>
                      <button className="btn btn-pink btn-sm w-full px-1 text-xs" onClick={() => untag(tag)}>
                        כן, להסיר
                      </button>
                      <button className="btn btn-plain btn-sm w-full px-1 text-xs" onClick={() => setUntagging(null)}>
                        ביטול
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-plain btn-sm w-full px-1 text-xs" onClick={() => setUntagging(tag.id)}>
                      {isMe ? 'זה לא אני' : 'הסרת התיוג'}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {isMe ? (
          <button className="btn btn-teal w-full" onClick={() => navigate('/me')}>
            זה הפרופיל שלך. לעריכה
          </button>
        ) : !person.claimed && !person.inMemoriam && !me ? (
          claiming ? (
            <form className="space-y-3 rounded-lg border-[3px] border-ink p-3" onSubmit={(e) => (e.preventDefault(), claim())}>
              <NewOwnerFields value={owner} onChange={setOwner} />
              <button className="btn btn-pink w-full" disabled={!newOwnerReady(owner)}>
                זה הפרופיל שלי
              </button>
            </form>
          ) : (
            <button className="btn btn-pink w-full" onClick={() => setClaiming(true)}>
              זה הפרופיל שלי! אני רוצה לערוך אותו
            </button>
          )
        ) : person.claimed && !me ? (
          signingIn ? (
            <div className="rounded-lg border-[3px] border-ink p-3">
              <CodeLogin person={person} />
            </div>
          ) : (
            <button className="btn btn-plain w-full" onClick={() => setSigningIn(true)}>
              זה הפרופיל שלי. כניסה עם הקוד האישי
            </button>
          )
        ) : null}
        {!isMe && !person.inMemoriam && (
          <button className="btn btn-plain w-full" onClick={() => setWriting(true)}>
            שליחת פתק
          </button>
        )}
        {!person.claimed && !isMe && <p className="text-sm opacity-70">אף אחד עדיין לא לקח בעלות על הפרופיל הזה.</p>}
        {error && <p className="font-bold text-pink">{error}</p>}
      </div>
      {writing && <NoteComposer to={person} onClose={() => setWriting(false)} />}
    </Drawer>
  )
}

/** Shown for a face nobody has named yet. Naming it creates (or links) a profile in one step. */
export function UnknownPanel({ tag, onClose, onNamed, layout }: { tag: Tag; onClose: () => void; onNamed: (personId: number) => void; layout: PanelLayout }) {
  const { people, scenes, me, adoptToken, reload } = useStore()
  const [mode, setMode] = useState<'me' | 'other' | null>(null)
  const [owner, setOwner] = useState<NewOwner>({ pin: '', email: '' })
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
      const { token, person } = await api<{ token: string; person: Person }>('/api/people', { json: { name, ...owner } })
      await adoptToken(token)
      await api(`/api/tags/${tag.id}/identify`, { method: 'POST' })
      return person.id
    })
  }

  const suggest = (body: { name: string } | { personId: number }) =>
    run(async () => (await api<{ personId: number }>(`/api/tags/${tag.id}/suggest`, { json: body })).personId)

  return (
    <Drawer onClose={onClose} layout={layout}>
      <div className="flex items-center gap-4 pe-10">
        <div className="polaroid w-28 shrink-0 rotate-2 pb-2">
          <img src={faceUrl(tag)} alt="" className="aspect-square w-full object-cover" />
        </div>
        <div className="sticky-note text-xl">מי בתמונה?</div>
      </div>
      <p className="mt-4">עדיין אין שם לתמונה הזו. עזרו למלא את ספר המחזור:</p>

      <div className="mt-3 flex gap-2">
        {me ? (
          <button className="btn btn-pink flex-1" disabled={busy} onClick={thatsMeExisting}>
            זאת התמונה שלי!
          </button>
        ) : (
          <button className={`btn flex-1 ${mode === 'me' ? 'btn-pink' : 'btn-plain'}`} onClick={() => setMode('me')}>
            זאת התמונה שלי!
          </button>
        )}
        <button className={`btn flex-1 ${mode === 'other' ? 'btn-teal' : 'btn-plain'}`} onClick={() => setMode('other')}>
          אני מזהה! להוספת שם
        </button>
      </div>

      {mode && !(mode === 'me' && me) && (
        <form className="mt-4 space-y-2" onSubmit={mode === 'me' ? thatsMeNew : (e) => (e.preventDefault(), suggest({ name }))}>
          <label className="label" htmlFor="face-name">
            {mode === 'me' ? 'השם שלך' : 'השם של מי שבתמונה'}
          </label>
          <input id="face-name" className="field" dir="auto" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          {matches.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-bold">כבר מופיעים בספר המחזור? בחרו:</p>
              {matches.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  dir="auto"
                  className="btn btn-plain btn-sm w-full justify-start"
                  disabled={busy || (mode === 'me' && (p.claimed || !newOwnerReady(owner)))}
                  onClick={() =>
                    mode === 'other'
                      ? suggest({ personId: p.id })
                      : run(async () => {
                          const { token } = await api<{ token: string }>(`/api/people/${p.id}/claim`, { json: owner })
                          await adoptToken(token)
                          await api(`/api/tags/${tag.id}/identify`, { method: 'POST' })
                          return p.id
                        })
                  }
                >
                  {p.name}
                  {mode === 'me' && p.claimed ? ' (הפרופיל כבר בבעלות מישהו)' : ''}
                </button>
              ))}
            </div>
          )}
          {mode === 'me' && <NewOwnerFields value={owner} onChange={setOwner} />}
          <button className="btn w-full" disabled={busy || name.trim().length < 2 || (mode === 'me' && !newOwnerReady(owner))}>
            {mode === 'me' ? 'יצירת הפרופיל שלי' : 'הוספת השם'}
          </button>
        </form>
      )}
      {error && <p className="mt-3 font-bold text-pink">{error}</p>}
    </Drawer>
  )
}
