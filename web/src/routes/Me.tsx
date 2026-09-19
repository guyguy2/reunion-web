import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, editToken, matchesPerson, type Person } from '../api.ts'
import { useStore } from '../store.tsx'
import { NotesInbox } from '../components/Notes.tsx'
import CodeLogin, { NewOwnerFields, newOwnerReady, type NewOwner } from '../components/CodeLogin.tsx'
import { LAYER, useEscape } from '../useEscape.ts'

type Draft = Partial<Record<'name' | 'formerName' | 'nickname' | 'email' | 'instagram' | 'linkedin' | 'facebook' | 'x' | 'website' | 'phone' | 'city' | 'bio' | 'quote', string>> & {
  attending: Person['attending']
  showEmail: boolean
  showInstagram: boolean
  showLinkedin: boolean
  showFacebook: boolean
  showWebsite: boolean
  showPhone: boolean
  showX: boolean
}

function toDraft(p: Person): Draft {
  return {
    name: p.name,
    formerName: p.formerName ?? '',
    nickname: p.nickname ?? '',
    email: p.email ?? '',
    instagram: p.instagram ?? '',
    linkedin: p.linkedin ?? '',
    facebook: p.facebook ?? '',
    website: p.website ?? '',
    phone: p.phone ?? '',
    x: p.x ?? '',
    city: p.city ?? '',
    bio: p.bio ?? '',
    quote: p.quote ?? '',
    attending: p.attending,
    showEmail: p.showEmail ?? true,
    showInstagram: p.showInstagram ?? true,
    showLinkedin: p.showLinkedin ?? true,
    showFacebook: p.showFacebook ?? true,
    showWebsite: p.showWebsite ?? true,
    showPhone: p.showPhone ?? true,
    showX: p.showX ?? true,
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
          {busy ? 'מפתחים...' : src ? 'החלפת תמונה' : 'העלאת תמונה'}
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

/** Choosing (or changing) the personal code that signs you in on another phone or computer. */
function PinSetter({ person }: { person: Person }) {
  const { reload } = useStore()
  const [pin, setPin] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [editing, setEditing] = useState(!person.hasPin)

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await api('/api/me/pin', { method: 'PUT', json: { pin } })
      setPin('')
      setEditing(false)
      setStatus({ kind: 'ok', text: 'הקוד נשמר. עכשיו אפשר להיכנס מכל מכשיר.' })
      await reload()
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message })
    }
  }

  return (
    <div className={`chunk space-y-2 p-4 ${person.hasPin ? '' : 'bg-sun'}`}>
      <p className="font-bold">{person.hasPin ? 'יש לכם קוד אישי.' : 'בחרו קוד אישי'}</p>
      <p className="text-sm">
        בטלפון או במחשב אחר: פתחו את הפרופיל שלכם בספר המחזור, לחצו "זה הפרופיל שלי" והקלידו את הקוד. לפחות 4 תווים, מספרים או מילה. אל תשתפו אותו.
      </p>
      {editing ? (
        <form onSubmit={save} className="flex gap-2">
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-label="קוד אישי"
            placeholder="הקוד שלכם"
          />
          <button className="btn btn-pink shrink-0" disabled={pin.trim().length < 4}>
            שמירה
          </button>
        </form>
      ) : (
        <button className="btn btn-plain btn-sm" onClick={() => (setEditing(true), setStatus(null))}>
          החלפת הקוד
        </button>
      )}
      {status && <p className={`text-sm font-bold ${status.kind === 'ok' ? 'text-teal' : 'text-pink'}`}>{status.text}</p>}
    </div>
  )
}

/** Already have a profile from another device: find your name, then type your personal code. */
function SignIn() {
  const { people } = useStore()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Person | null>(null)
  const matches = query.trim().length > 1 ? people.filter((p) => p.claimed && matchesPerson(p, query)).slice(0, 5) : []

  return (
    <div className="chunk space-y-3 bg-sun p-5">
      <h2 className="font-display text-xl">כבר יש לכם פרופיל?</h2>
      <p>נכנסים מטלפון או ממחשב אחר? חפשו את השם שלכם והקלידו את הקוד האישי.</p>
      {picked ? (
        <>
          <CodeLogin person={picked} />
          <button className="btn btn-plain btn-sm" onClick={() => setPicked(null)}>
            זה לא אני
          </button>
        </>
      ) : (
        <>
          <input className="field" type="search" dir="auto" placeholder="השם שלכם" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="השם שלכם" />
          {matches.map((p) => (
            <button key={p.id} className="btn btn-plain btn-sm w-full justify-start" dir="auto" onClick={() => setPicked(p)}>
              {p.name}
            </button>
          ))}
        </>
      )}
    </div>
  )
}

function Join() {
  const { people, adoptToken, reload } = useStore()
  const [name, setName] = useState('')
  const [owner, setOwner] = useState<NewOwner>({ pin: '', email: '' })
  const [error, setError] = useState('')
  const sameName = name.trim().length > 1 ? people.filter((p) => p.claimed && matchesPerson(p, name)) : []

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const { token } = await api<{ token: string }>('/api/people', { json: { name, ...owner } })
      await adoptToken(token)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
      <h1 className="heading">הפרופיל שלי</h1>
      <SignIn />
      <div className="chunk space-y-3 p-5">
        <h2 className="font-display text-xl">פעם ראשונה? מצאו את עצמכם</h2>
        <p>
          פתחו את ספר המחזור ולחצו על התמונה שלכם. אם מישהו כבר הוסיף את שמכם, לחצו על "זה הפרופיל שלי". אם לא, חפשו את עצמכם בין הפנים בלי שם,
          לחצו על "זאת התמונה שלי!" והקלידו את שמכם.
        </p>
        <Link to="/" className="btn btn-pink">
          לספר המחזור
        </Link>
      </div>
      <form onSubmit={submit} className="chunk space-y-3 p-5">
        <h2 className="font-display text-xl">לא מופיעים באף תמונה?</h2>
        <p>פספסתם את יום הצילומים? הוסיפו את עצמכם בכל זאת.</p>
        <label className="label" htmlFor="join-name">
          השם שלך
        </label>
        <input id="join-name" className="field" dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        {sameName.length > 0 && (
          <p className="rounded-lg border-[3px] border-ink bg-sun p-3 text-sm font-bold">
            כבר יש פרופיל בשם {sameName.map((p) => p.name).join(', ')}. אם זה אתם, אל תיצרו פרופיל חדש: היכנסו עם הקוד האישי למעלה.
          </p>
        )}
        <NewOwnerFields value={owner} onChange={setOwner} />
        {error && <p className="font-bold text-pink">{error}</p>}
        <button className="btn" disabled={name.trim().length < 2 || !newOwnerReady(owner)}>
          יצירת הפרופיל שלי
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
  useEscape(confirmRemove && (() => setConfirmRemove(false)), LAYER.dialog)

  // Arriving via a private edit link: adopt the token, then drop it from the address bar.
  useEffect(() => {
    if (!tokenFromLink) return
    adoptToken(tokenFromLink).then((person) => {
      if (!person) setLinkError('קישור העריכה כבר לא בתוקף. בקשו מאחד המארגנים לאפס את הפרופיל.')
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
      setStatus({ kind: 'ok', text: 'נשמר. נראה מעולה!' })
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
  const visibility = (key: 'showEmail' | 'showInstagram' | 'showLinkedin' | 'showFacebook' | 'showWebsite' | 'showPhone' | 'showX', label: string) => (
    <label className="flex items-center gap-2 text-sm font-bold">
      <input type="checkbox" className="h-5 w-5 accent-pink" checked={draft[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <h1 className="heading">הפרופיל שלי</h1>
      {search.get('welcome') && <p className="text-lg font-bold">ברוכים הבאים!</p>}

      <PinSetter key={String(me.hasPin)} person={me} />

      <div className="chunk space-y-2 p-4">
        <p className="font-bold">קישור העריכה הפרטי שלכם</p>
        <p className="text-sm">הדפדפן הזה יזכור אתכם. הקישור שלמטה הוא עוד דרך להיכנס ממכשיר אחר, גם בלי קוד. אל תשתפו אותו.</p>
        <div className="flex gap-2">
          <input className="field pixel text-lg" dir="ltr" readOnly value={editLink} onFocus={(e) => e.target.select()} aria-label="קישור עריכה פרטי" />
          <button className="btn btn-plain shrink-0" onClick={() => navigator.clipboard.writeText(editLink).then(() => setCopied(true))}>
            {copied ? 'הועתק' : 'העתקה'}
          </button>
        </div>
      </div>

      <NotesInbox />

      <form onSubmit={save} className="chunk space-y-4 p-5">
        {text('name', 'שם')}
        <div className="grid gap-4 sm:grid-cols-2">
          {text('formerName', 'השם אז (אם השתנה)')}
          {text('nickname', 'כינוי')}
        </div>
        {text('city', 'איפה גרים היום?')}
        <div>
          <label className="label" htmlFor="f-bio">
            מה קרה מאז?
          </label>
          <textarea id="f-bio" className="field min-h-28" dir="auto" maxLength={1500} value={draft.bio} onChange={(e) => set('bio', e.target.value)} />
        </div>
        {text('quote', 'ציטוט לספר המחזור', { placeholder: 'הכי סביר ש...' })}

        <fieldset>
          <legend className="label">מגיעים לפגישת המחזור?</legend>
          <div className="flex flex-wrap gap-2">
            {(['yes', 'maybe', 'no'] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={`btn btn-sm ${draft.attending === value ? 'btn-pink' : 'btn-plain'}`}
                aria-pressed={draft.attending === value}
                onClick={() => set('attending', draft.attending === value ? null : value)}
              >
                {{ yes: 'אהיה שם', maybe: 'אולי', no: 'לא אוכל להגיע' }[value]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border-[3px] border-dashed border-ink p-4">
          <legend className="label px-2">יצירת קשר (רק בוגרים עם הסיסמה רואים את הפרטים)</legend>
          {text('email', 'אימייל', { type: 'email' })}
          {visibility('showEmail', 'להציג את האימייל שלי')}
          {text('phone', 'טלפון', { type: 'tel', placeholder: '050-1234567' })}
          {visibility('showPhone', 'להציג את הטלפון שלי')}
          {text('instagram', 'אינסטגרם', { placeholder: '@handle' })}
          {visibility('showInstagram', 'להציג את האינסטגרם שלי')}
          {text('linkedin', 'קישור ללינקדאין')}
          {visibility('showLinkedin', 'להציג את הלינקדאין שלי')}
          {text('facebook', 'פייסבוק', { placeholder: 'שם משתמש או קישור לפרופיל' })}
          {visibility('showFacebook', 'להציג את הפייסבוק שלי')}
          {text('x', 'X (טוויטר)', { placeholder: '@handle' })}
          {visibility('showX', 'להציג את ה-X שלי')}
          {text('website', 'אתר או קישור נוסף', { placeholder: 'אתר אישי, עסק, טיקטוק...' })}
          {visibility('showWebsite', 'להציג את הקישור')}
        </fieldset>

        {status && (
          <p role="status" className={`rounded-lg border-[3px] border-ink p-3 font-bold ${status.kind === 'ok' ? 'bg-teal text-white' : 'bg-pink text-white'}`}>
            {status.text}
          </p>
        )}
        <button className="btn btn-pink w-full">שמירת הפרופיל</button>
      </form>

      <div className="chunk space-y-5 p-5">
        <h2 className="font-display text-xl">אז והיום</h2>
        <PhotoField label="היום" hint="תמונה עדכנית שלך. תופיע ליד התמונה מ-1996." src={me.nowPhoto} onUpload={(f) => upload('now', f)} />
        <PhotoField
          label="אז (לא חובה)"
          hint="יש לכם תמונה טובה יותר משנות ה-90? אפשר להשתמש בה במקום."
          src={me.thenPhoto}
          onUpload={(f) => upload('then', f)}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <button className="btn btn-plain btn-sm" onClick={() => navigate(`/p/${me.id}`)}>
          הפרופיל שלי בספר המחזור
        </button>
        <button className="btn btn-plain btn-sm" onClick={() => (forgetMe(), navigate('/'))}>
          זה לא הפרופיל שלי (התנתקות ממנו)
        </button>
        <button className="btn btn-plain btn-sm text-pink" onClick={() => setConfirmRemove(true)}>
          הסרת הפרטים שלי
        </button>
      </div>
      {confirmRemove && (
        <div className="chunk space-y-3 bg-pink p-4 text-white" role="alertdialog" aria-label="אישור הסרה">
          <p className="font-bold">להסיר מהאתר את פרטי הקשר, מה שכתבתם ואת התמונה העדכנית? השם יישאר על תמונות המחזור.</p>
          <div className="flex gap-3">
            <button className="btn btn-plain btn-sm" onClick={removeMe}>
              כן, להסיר
            </button>
            <button className="btn btn-plain btn-sm" onClick={() => setConfirmRemove(false)}>
              להשאיר
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
