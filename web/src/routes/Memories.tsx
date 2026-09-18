import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { useStore } from '../store.tsx'

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

  useEffect(() => {
    if (open === null || !photos) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
      if (e.key === 'ArrowRight') setOpen((i) => (i === null ? i : (i + 1) % photos.length))
      if (e.key === 'ArrowLeft') setOpen((i) => (i === null ? i : (i - 1 + photos.length) % photos.length))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, photos])

  const albumButtons = memories?.albumUrl && (
    <div className="flex flex-wrap gap-3">
      <a className="btn btn-pink" href={memories.albumUrl} target="_blank" rel="noreferrer">
        Open the full album
      </a>
      <a className="btn btn-plain" href={memories.albumUrl} target="_blank" rel="noreferrer">
        Add your photos
      </a>
    </div>
  )

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-28">
      <h1 className="heading">Memory Board</h1>

      {/* A one-hour-photo envelope. */}
      <div className="chunk relative bg-sun p-5 shadow-chunk-lg sm:p-6">
        <div className="pixel absolute top-2 right-4 hidden text-xl sm:block">1-HOUR PHOTO / {photos?.length || 24} EXP.</div>
        <h2 className="font-display text-2xl" dir="auto">
          {memories?.albumTitle ?? 'Shared album'}
        </h2>
        <p className="mt-1 mb-4 max-w-2xl text-lg" dir="auto">
          {memories?.blurb}
        </p>
        {albumButtons || <p className="font-bold">The album link has not been set up yet.</p>}
        <p className="mt-3 text-sm">
          The album lives on Google Photos. To add pictures, open it while signed in to a Google account and use the add-photos button.
        </p>
      </div>

      {photos === null && <p className="pixel text-center text-2xl">Developing photos...</p>}

      {photos && photos.length > 0 && (
        <div className="columns-2 gap-4 sm:columns-3 lg:columns-4">
          {photos.map((photo, i) => (
            <button
              key={photo.src}
              onClick={() => setOpen(i)}
              className={`polaroid mb-4 block w-full cursor-zoom-in break-inside-avoid pb-3 transition-transform hover:z-10 hover:scale-[1.03] hover:rotate-0 ${TILTS[i % TILTS.length]}`}
              aria-label={`Open photo ${i + 1}`}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4" role="dialog" aria-label="Photo viewer" onClick={() => setOpen(null)}>
          <img
            src={`${photos[open].src}=w1800`}
            alt=""
            referrerPolicy="no-referrer"
            className="max-h-full max-w-full border-[6px] border-white object-contain shadow-chunk-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute inset-x-0 bottom-4 flex justify-center gap-3" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-plain pixel text-xl" onClick={() => setOpen((open - 1 + photos.length) % photos.length)} aria-label="Previous photo">
              {'<<'} REW
            </button>
            <span className="lcd text-xl">
              {open + 1}/{photos.length}
            </span>
            <button className="btn btn-plain pixel text-xl" onClick={() => setOpen((open + 1) % photos.length)} aria-label="Next photo">
              FF {'>>'}
            </button>
            <button className="btn btn-pink pixel text-xl" onClick={() => setOpen(null)}>
              CLOSE
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
