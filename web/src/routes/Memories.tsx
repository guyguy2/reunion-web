import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { useStore } from '../store.tsx'
import { LAYER, useEscape } from '../useEscape.ts'

interface AlbumPhoto {
  src: string
  width: number
  height: number
}

const TILTS = ['-rotate-2', 'rotate-1', '-rotate-1', 'rotate-2', 'rotate-0']

export default function Memories() {
  const { event } = useStore()
  const memories = event?.memories
  const [photos, setPhotos] = useState<AlbumPhoto[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    api<AlbumPhoto[]>('/api/memories/photos')
      .then(setPhotos)
      .catch(() => setPhotos([]))
  }, [])

  useEscape(open !== null && (() => setOpen(null)), LAYER.dialog)

  useEffect(() => {
    if (open === null || !photos) return
    const onKey = (e: KeyboardEvent) => {
      // Right-to-left page: the left arrow moves forward.
      if (e.key === 'ArrowLeft') setOpen((i) => (i === null ? i : (i + 1) % photos.length))
      if (e.key === 'ArrowRight') setOpen((i) => (i === null ? i : (i - 1 + photos.length) % photos.length))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, photos])

  const albumButtons = memories?.albumUrl && (
    <div className="flex flex-wrap gap-3">
      <a className="btn btn-pink" href={memories.albumUrl} target="_blank" rel="noreferrer">
        לאלבום המלא
      </a>
      <a className="btn btn-plain" href={memories.albumUrl} target="_blank" rel="noreferrer">
        הוסיפו תמונות משלכם
      </a>
    </div>
  )

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <h1 className="heading">לוח הזכרונות</h1>

      {/* A one-hour-photo envelope. */}
      <div className="chunk relative bg-sun p-5 shadow-chunk-lg sm:p-6">
        <div className="pixel absolute end-4 top-2 hidden text-xl sm:block">פיתוח בשעה / {photos?.length || 24} תמונות</div>
        <h2 className="font-display text-2xl" dir="auto">
          {memories?.albumTitle ?? 'אלבום משותף'}
        </h2>
        <p className="mt-1 mb-4 max-w-2xl text-lg" dir="auto">
          {memories?.blurb}
        </p>
        {albumButtons || <p className="font-bold">קישור האלבום עדיין לא הוגדר.</p>}
        <p className="mt-3 text-sm">
          האלבום נמצא ב-Google Photos. כדי להוסיף תמונות, פתחו אותו כשאתם מחוברים לחשבון גוגל והשתמשו בכפתור הוספת התמונות.
        </p>
      </div>

      {photos === null && <p className="pixel text-center text-2xl">מפתחים תמונות...</p>}

      {photos && photos.length > 0 && (
        <div className="columns-2 gap-4 sm:columns-3 lg:columns-4">
          {photos.map((photo, i) => (
            <button
              key={photo.src}
              onClick={() => setOpen(i)}
              className={`polaroid mb-4 block w-full cursor-zoom-in break-inside-avoid pb-3 transition-transform hover:z-10 hover:scale-[1.03] hover:rotate-0 ${TILTS[i % TILTS.length]}`}
              aria-label={`פתיחת תמונה ${i + 1}`}
            >
              {/* no-referrer keeps the site address out of requests to Google's image servers. */}
              <img
                src={`${photo.src}=w480`}
                width={photo.width}
                height={photo.height}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-auto w-full bg-paper"
              />
            </button>
          ))}
        </div>
      )}

      {open !== null && photos?.[open] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4" role="dialog" aria-label="צפייה בתמונה" onClick={() => setOpen(null)}>
          <img
            src={`${photos[open].src}=w1800`}
            alt=""
            referrerPolicy="no-referrer"
            className="max-h-full max-w-full border-[6px] border-white object-contain shadow-chunk-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute inset-x-0 bottom-4 flex justify-center gap-3" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-plain pixel text-xl" onClick={() => setOpen((open - 1 + photos.length) % photos.length)} aria-label="התמונה הקודמת">
              הקודמת
            </button>
            <span className="lcd text-xl">
              {open + 1}/{photos.length}
            </span>
            <button className="btn btn-plain pixel text-xl" onClick={() => setOpen((open + 1) % photos.length)} aria-label="התמונה הבאה">
              הבאה
            </button>
            <button className="btn btn-pink pixel text-xl" onClick={() => setOpen(null)}>
              סגירה
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
