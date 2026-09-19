import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Video } from '../api.ts'
import { useStore } from '../store.tsx'
import { mixtape } from '../components/Cassette.tsx'
import { PROVIDER_NAME, embedUrl, isTallEmbed, thumbnailUrl } from '../videos.ts'

const PROVIDER_COLOR: Record<Video['provider'], string> = {
  youtube: 'bg-pink',
  instagram: 'bg-grape',
  facebook: 'bg-sky',
  x: 'bg-ink',
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
        {playing ? (
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
            {thumb && <img src={thumb} alt="" className="h-full w-full object-cover opacity-90" loading="lazy" />}
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

function AddVideo({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const { me } = useStore()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ url: '', title: '', note: '', addedBy: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
      <h1 className="heading">ספריית הווידאו</h1>
      <p className="max-w-2xl text-lg">סרטונים ביתיים, טקסים והצגות. נא להחזיר את הקלטת להתחלה.</p>
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
