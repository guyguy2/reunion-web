import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, editToken, type Person } from '../api.ts'
import { useStore } from '../store.tsx'

type Draft = Partial<Record<'name' | 'formerName' | 'nickname' | 'email' | 'instagram' | 'linkedin' | 'city' | 'bio' | 'quote', string>> & {
  attending: Person['attending']
  showEmail: boolean
  showInstagram: boolean
  showLinkedin: boolean
}

function toDraft(p: Person): Draft {
  return {
    name: p.name,
    formerName: p.formerName ?? '',
    nickname: p.nickname ?? '',
    email: p.email ?? '',
    instagram: p.instagram ?? '',
    linkedin: p.linkedin ?? '',
    city: p.city ?? '',
    bio: p.bio ?? '',
    quote: p.quote ?? '',
    attending: p.attending,
    showEmail: p.showEmail ?? true,
    showInstagram: p.showInstagram ?? true,
    showLinkedin: p.showLinkedin ?? true,
  }
}

function PhotoField({ label, hint, src, onUpload }: { label: string; hint: string; src: string | null; onUpload: (file: File) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex items-center gap-4">
      <div className="polaroid w-24 shrink-0 pb-2">
        {src ? <img src={src} alt="" className="aspect-[4/5] w-full object-cover" /> : <div className="aspect-[4/5] w-full bg-paper" />}
      </div>
      <div>
        <p className="label">{label}</p>
        <p className="mb-2 text-sm opacity-70">{hint}</p>
        <label className={`btn btn-plain btn-sm ${busy ? 'opacity-50' : ''}`}>
          {busy ? 'Developing...' : src ? 'Replace photo' : 'Upload photo'}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              setBusy(true)
              await onUpload(file).finally(() => setBusy(false))
            }}
          />
        </label>
      </div>
    </div>
  )
}

function Join() {
  const { adoptToken, reload } = useStore()
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const { token } = await api<{ token: string }>('/api/people', { json: { name } })
      await adoptToken(token)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
      <h1 className="heading">My Profile</h1>
      <div className="chunk space-y-3 p-5">
        <h2 className="font-display text-xl">Option 1: find your face</h2>
        <p>
          Open the yearbook, zoom in on your 1996 self and tap your face. If someone already added your name, hit "This is me". If not, tap
          "That's me!" and type your name.
        </p>
        <Link to="/" className="btn btn-pink">
          Open the yearbook
        </Link>
      </div>
      <form onSubmit={submit} className="chunk space-y-3 p-5">
        <h2 className="font-display text-xl">Option 2: not in any picture?</h2>
        <p>Missed picture day? Add yourself anyway.</p>
        <label className="label" htmlFor="join-name">
          Your name
        </label>
        <input id="join-name" className="field" dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        {error && <p className="font-bold text-pink">{error}</p>}
        <button className="btn" disabled={name.trim().length < 2}>
          Create my profile
        </button>
      </form>
    </div>
  )
}

export default function Me() {
  const { me, adoptToken, forgetMe, reload } = useStore()
  const { token: tokenFromLink } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [linkError, setLinkError] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Arriving via a private edit link: adopt the token, then drop it from the address bar.
  useEffect(() => {
    if (!tokenFromLink) return
    adoptToken(tokenFromLink).then((person) => {
      if (!person) setLinkError('That edit link is not valid any more. Ask an organizer to reset your profile.')
      navigate('/me', { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromLink])

  useEffect(() => {
    setDraft(me ? toDraft(me) : null)
  }, [me])

  if (tokenFromLink) return null
  if (!me || !draft) {
    return (
      <>
        {linkError && <p className="mx-auto mt-6 max-w-2xl rounded-lg border-[3px] border-ink bg-pink p-3 font-bold text-white">{linkError}</p>}
        <Join />
      </>
    )
  }

  const editLink = `${location.origin}/me/${editToken.get() ?? ''}`
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value })

  async function save(e: FormEvent) {
    e.preventDefault()
    setStatus(null)
    try {
      await api('/api/me', { method: 'PATCH', json: draft })
      await reload()
      setStatus({ kind: 'ok', text: 'Saved. Looking good!' })
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message })
    }
  }

  async function upload(kind: 'then' | 'now', file: File) {
    const body = new FormData()
    body.set('photo', file)
    try {
      await api(`/api/me/photo/${kind}`, { body })
      await reload()
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message })
    }
  }

  async function removeMe() {
    await api('/api/me', { method: 'DELETE' })
    forgetMe()
    await reload()
    navigate('/')
  }

  const text = (key: keyof Draft, label: string, props: { type?: string; placeholder?: string } = {}) => (
    <div>
      <label className="label" htmlFor={`f-${key}`}>
        {label}
      </label>
      <input id={`f-${key}`} className="field" dir="auto" value={(draft[key] as string) ?? ''} onChange={(e) => set(key, e.target.value as never)} {...props} />
    </div>
  )
  const visibility = (key: 'showEmail' | 'showInstagram' | 'showLinkedin', label: string) => (
    <label className="flex items-center gap-2 text-sm font-bold">
      <input type="checkbox" className="h-5 w-5 accent-pink" checked={draft[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <h1 className="heading">My Profile</h1>

      <div className="chunk space-y-2 bg-sun p-4">
        <p className="font-bold">{search.get('welcome') ? 'Welcome back! ' : ''}Save your private edit link.</p>
        <p className="text-sm">This browser will remember you, but the link below is the only way to edit your profile from another device. Do not share it.</p>
        <div className="flex gap-2">
          <input className="field pixel text-lg" readOnly value={editLink} onFocus={(e) => e.target.select()} aria-label="Private edit link" />
          <button className="btn btn-plain shrink-0" onClick={() => navigator.clipboard.writeText(editLink).then(() => setCopied(true))}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <form onSubmit={save} className="chunk space-y-4 p-5">
        {text('name', 'Name')}
        <div className="grid gap-4 sm:grid-cols-2">
          {text('formerName', 'Name back then (if it changed)')}
          {text('nickname', 'Nickname')}
        </div>
        {text('city', 'Where do you live now?')}
        <div>
          <label className="label" htmlFor="f-bio">
            What have you been up to?
          </label>
          <textarea id="f-bio" className="field min-h-28" dir="auto" maxLength={1500} value={draft.bio} onChange={(e) => set('bio', e.target.value)} />
        </div>
        {text('quote', 'Yearbook quote', { placeholder: 'Most likely to...' })}

        <fieldset>
          <legend className="label">Coming to the reunion?</legend>
          <div className="flex flex-wrap gap-2">
            {(['yes', 'maybe', 'no'] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={`btn btn-sm ${draft.attending === value ? 'btn-pink' : 'btn-plain'}`}
                aria-pressed={draft.attending === value}
                onClick={() => set('attending', draft.attending === value ? null : value)}
              >
                {{ yes: "I'll be there", maybe: 'Maybe', no: "Can't make it" }[value]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border-[3px] border-dashed border-ink p-4">
          <legend className="label px-2">Contact (only classmates with the passcode can see these)</legend>
          {text('email', 'Email', { type: 'email' })}
          {visibility('showEmail', 'Show my email to classmates')}
          {text('instagram', 'Instagram', { placeholder: '@handle' })}
          {visibility('showInstagram', 'Show my Instagram')}
          {text('linkedin', 'LinkedIn URL')}
          {visibility('showLinkedin', 'Show my LinkedIn')}
        </fieldset>

        {status && (
          <p role="status" className={`rounded-lg border-[3px] border-ink p-3 font-bold ${status.kind === 'ok' ? 'bg-teal text-white' : 'bg-pink text-white'}`}>
            {status.text}
          </p>
        )}
        <button className="btn btn-pink w-full">Save profile</button>
      </form>

      <div className="chunk space-y-5 p-5">
        <h2 className="font-display text-xl">Then and now</h2>
        <PhotoField label="Now" hint="A recent photo of you. Shows up next to your 1996 face." src={me.nowPhoto} onUpload={(f) => upload('now', f)} />
        <PhotoField
          label="Then (optional)"
          hint="Got a better 90s photo than the class picture? Use it instead."
          src={me.thenPhoto}
          onUpload={(f) => upload('then', f)}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <button className="btn btn-plain btn-sm" onClick={() => navigate(`/p/${me.id}`)}>
          See my profile in the yearbook
        </button>
        <button className="btn btn-plain btn-sm" onClick={() => (forgetMe(), navigate('/'))}>
          This is not me (sign out of this profile)
        </button>
        <button className="btn btn-plain btn-sm text-pink" onClick={() => setConfirmRemove(true)}>
          Remove my info
        </button>
      </div>
      {confirmRemove && (
        <div className="chunk space-y-3 bg-pink p-4 text-white" role="alertdialog" aria-label="Confirm removal">
          <p className="font-bold">Remove your contact details, bio and "now" photo from the site? Your name stays on the class pictures.</p>
          <div className="flex gap-3">
            <button className="btn btn-plain btn-sm" onClick={removeMe}>
              Yes, remove my info
            </button>
            <button className="btn btn-plain btn-sm" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
