import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Video } from '../api.ts'
import { useStore } from '../store.tsx'
import { mixtape } from '../components/Cassette.tsx'
import { PROVIDER_NAME, embedUrl, isTallEmbed, streamUrls, thumbnailUrl } from '../videos.ts'
import { LAYER, useEscape } from '../useEscape.ts'

const PROVIDER_COLOR: Record<Video['provider'], string> = {
  youtube: 'bg-pink',
  instagram: 'bg-grape',
  facebook: 'bg-sky',
  x: 'bg-ink',
  gphotos: 'bg-teal',
}

/** Thumbnail first; the real player only loads on click, and the mixtape pauses so two soundtracks never fight. */
function Tape({ video, onRemove }: { video: Video; onRemove?: () => void }) {
  const [playing, setPlaying] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const thumb = thumbnailUrl(video)
  const tall = playing && isTallEmbed(video.provider)
  return (
    <article className="chunk overflow-hidden">
      <div className={`relative bg-ink ${tall ? 'h-[40rem]' : 'aspect-video'}`}>
        {playing && video.provider === 'gphotos' ? (
          // A 404 on the 720p copy makes the browser fall through to the next source.
          <video className="absolute inset-0 h-full w-full" controls autoPlay playsInline poster={thumb ?? undefined} title={video.title}>
            {streamUrls(video).map((src) => (
              <source key={src} src={src} type="video/mp4" />
            ))}
          </video>
        ) : playing ? (
          <iframe
            className={`absolute inset-0 h-full w-full ${tall ? 'bg-white' : ''}`}
            src={embedUrl(video)}
            title={video.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write"
            // The site sends no referrer by default; YouTube refuses to play without one (error 153).
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        ) : (
          <button
            className={`group absolute inset-0 cursor-pointer ${thumb ? '' : PROVIDER_COLOR[video.provider]}`}
            onClick={() => (mixtape.pause(), setPlaying(true))}
            aria-label={`ניגון ${video.title}`}
          >
            {thumb && <img src={thumb} alt="" className="h-full w-full object-cover opacity-90" loading="lazy" referrerPolicy="no-referrer" />}
            <span className="pixel absolute start-3 top-2 text-2xl text-white drop-shadow" dir="ltr">
              {thumb ? 'PLAY' : PROVIDER_NAME[video.provider]}
            </span>
            <span className="btn btn-pink absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 group-hover:scale-105">לחצו לניגון</span>
          </button>
        )}
      </div>
      {/* VHS spine label */}
      <div className="space-y-1 border-t-[3px] border-ink bg-paper p-3">
        <h2 className="marker text-xl leading-tight" dir="auto">
          {video.title}
        </h2>
        {video.note && (
          <p className="text-sm" dir="auto">
            {video.note}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {video.addedBy && <span dir="auto">הוסיף/ה: {video.addedBy}</span>}
          <a className="underline" href={video.url} target="_blank" rel="noreferrer">
            לצפייה ב-{PROVIDER_NAME[video.provider]}
          </a>
          {onRemove &&
            (confirmRemove ? (
              <span className="flex gap-1">
                <button className="btn btn-pink btn-sm" onClick={onRemove}>
                  להסיר באמת
                </button>
                <button className="btn btn-plain btn-sm" onClick={() => setConfirmRemove(false)}>
                  ביטול
                </button>
              </span>
            ) : (
              <button className="btn btn-plain btn-sm text-pink" onClick={() => setConfirmRemove(true)}>
                הסרה
              </button>
            ))}
        </div>
      </div>
    </article>
  )
}

/**
 * A home-recorded VHS tape for the page header, drawn as a sticker: a gray shell with a ridged flap on top, the tape
 * rolls showing through windows at both ends, and a lined label in the middle.
 */
function VhsCassette({ className }: { className?: string }) {
  const windows = [
    { x: 30, cx: 58, r: 38 },
    { x: 226, cx: 262, r: 30 },
  ]
  return (
    <svg viewBox="0 0 320 184" className={className} aria-hidden="true">
      <defs>
        {windows.map((w) => (
          <clipPath key={w.x} id={`vhs-window-${w.x}`}>
            <rect x={w.x} y="70" width="64" height="80" rx="10" />
          </clipPath>
        ))}
      </defs>
      <rect x="1" y="3" width="318" height="178" rx="16" fill="#fff" />
      <rect x="8" y="10" width="304" height="164" rx="10" fill="#4a4a50" stroke="#151515" strokeWidth="5" />
      <path d="M8 52V20a10 10 0 0 1 10-10h284a10 10 0 0 1 10 10v32z" fill="#5c5c63" stroke="#151515" strokeWidth="5" strokeLinejoin="round" />
      {[32, 38, 44].map((y) => (
        <path key={y} d={`M22 ${y}h276`} stroke="#3e3e44" strokeWidth="2" />
      ))}
      <path d="M160 15l-6 8h4v5h4v-5h4z" fill="#2c2c31" />
      <rect x="264" y="16" width="34" height="13" rx="2" fill="none" stroke="#2c2c31" strokeWidth="1.5" />
      <text x="281" y="27" textAnchor="middle" direction="ltr" fontFamily="DM Sans, Rubik, sans-serif" fontSize="10" fontWeight="700" fill="#2c2c31">
        VHS
      </text>
      <rect x="20" y="60" width="280" height="100" rx="8" fill="#3b3b40" stroke="#151515" strokeWidth="3" />
      {windows.map((w) => (
        <g key={w.x}>
          <rect x={w.x} y="70" width="64" height="80" rx="10" fill="#d6d1c4" />
          <g clipPath={`url(#vhs-window-${w.x})`}>
            <circle cx={w.cx} cy="110" r={w.r} fill="#8a5a2b" />
            {[w.r - 6, w.r - 12, w.r - 18].map((r) => (
              <circle key={r} cx={w.cx} cy="110" r={r} fill="none" stroke="#6e4520" strokeWidth="1.5" />
            ))}
            <circle cx={w.cx} cy="110" r="12" fill="#e9e9ec" stroke="#151515" strokeWidth="2.5" />
            <circle cx={w.cx} cy="110" r="5" fill="#4a4a50" />
          </g>
          <rect x={w.x} y="70" width="64" height="80" rx="10" fill="none" stroke="#151515" strokeWidth="3" />
        </g>
      ))}
      <rect x="104" y="68" width="112" height="84" rx="4" fill="#fdf6e3" stroke="#151515" strokeWidth="3" />
      <path d="M105.5 69.5h109v17h-109z" fill="#fb923c" />
      <path d="M104 87h112" stroke="#151515" strokeWidth="2" />
      {[100, 112, 124, 136].map((y) => (
        <path key={y} d={`M112 ${y}h96`} stroke="#cfc4a8" strokeWidth="1.5" />
      ))}
      <text x="160" y="121" textAnchor="middle" fontFamily="Permanent Marker, Gveret Levin, Rubik, cursive" fontSize="17" fill="#151515">
        לא למחוק!
      </text>
    </svg>
  )
}

function AddVideo({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const { me } = useStore()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ url: '', title: '', note: '', addedBy: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEscape(open && (() => setOpen(false)), LAYER.drawer)

  const start = () => {
    setForm((f) => ({ ...f, addedBy: f.addedBy || me?.name || '' }))
    setError('')
    setOpen(true)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api<Video>('/api/videos', { json: form })
      await onAdded()
      setForm((f) => ({ ...f, url: '', title: '', note: '' }))
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button className="btn btn-teal" onClick={start}>
        + הוספת סרטון
      </button>
    )
  }
  return (
    <form onSubmit={submit} className="chunk max-w-xl space-y-3 p-4">
      <div>
        <label className="label" htmlFor="video-url">
          קישור לסרטון
        </label>
        <input
          id="video-url"
          className="field"
          dir="ltr"
          inputMode="url"
          autoFocus
          required
          placeholder="YouTube / Instagram / Facebook / X"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor="video-title">
          שם הסרטון (לא חובה)
        </label>
        <input
          id="video-title"
          className="field"
          dir="auto"
          maxLength={80}
          placeholder="למשל: מסיבת סיום, יוני 96"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </div>
      <div>
        <label className="label" htmlFor="video-note">
          כמה מילים (לא חובה)
        </label>
        <input id="video-note" className="field" dir="auto" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="video-by">
          מי מוסיף/ה? (לא חובה)
        </label>
        <input id="video-by" className="field" dir="auto" maxLength={60} value={form.addedBy} onChange={(e) => setForm({ ...form, addedBy: e.target.value })} />
      </div>
      {error && <p className="font-bold text-pink">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-pink flex-1" disabled={saving || !form.url.trim()}>
          {saving ? 'מוסיפים...' : 'הוספה לספרייה'}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setOpen(false)}>
          ביטול
        </button>
      </div>
    </form>
  )
}

export default function Videos() {
  const { role } = useStore()
  const [videos, setVideos] = useState<Video[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => api<Video[]>('/api/videos').then(setVideos), [])
  useEffect(() => {
    load().catch((err) => setError((err as Error).message))
  }, [load])

  const remove = async (id: number) => {
    try {
      await api(`/api/admin/videos/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-4">
        <div className="space-y-6">
          <h1 className="heading">ספריית הווידאו</h1>
          <p className="max-w-2xl text-lg">סרטונים ביתיים, טקסים והצגות. נא להחזיר את הקלטת להתחלה.</p>
        </div>
        <VhsCassette className="w-28 shrink-0 -rotate-3 drop-shadow-[3px_4px_3px_rgb(0_0_0/0.3)] sm:w-64" />
      </header>
      <AddVideo onAdded={load} />
      {error && <p className="font-bold text-pink">{error}</p>}
      {videos?.length === 0 ? (
        <div className="sticky-note max-w-md text-lg">עדיין אין קלטות על המדף. יש לכם סרטון מאז? הדביקו קישור מיוטיוב, אינסטגרם, פייסבוק או X.</div>
      ) : (
        <div className="grid items-start gap-6 sm:grid-cols-2">
          {videos?.map((v) => (
            <Tape key={v.id} video={v} onRemove={role === 'admin' && v.id > 0 ? () => remove(v.id) : undefined} />
          ))}
        </div>
      )}
    </div>
  )
}
