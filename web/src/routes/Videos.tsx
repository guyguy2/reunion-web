import { useState } from 'react'
import { useStore } from '../store.tsx'
import { mixtape } from '../components/Cassette.tsx'

export function youtubeId(url: string): string | null {
  const match = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/)
  return match ? match[1] : /^[\w-]{11}$/.test(url) ? url : null
}

/** Thumbnail first; the real player only loads on click, and the mixtape pauses so two soundtracks never fight. */
function Tape({ title, note, id }: { title: string; note?: string; id: string }) {
  const [playing, setPlaying] = useState(false)
  return (
    <article className="chunk overflow-hidden">
      <div className="relative aspect-video bg-ink">
        {playing ? (
          <iframe
            className="absolute inset-0 h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : (
          <button className="group absolute inset-0 cursor-pointer" onClick={() => (mixtape.pause(), setPlaying(true))} aria-label={`Play ${title}`}>
            <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" className="h-full w-full object-cover opacity-90" loading="lazy" />
            <span className="pixel absolute top-2 left-3 text-2xl text-white drop-shadow">PLAY &gt;</span>
            <span className="btn btn-pink absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 group-hover:scale-105">Press play</span>
          </button>
        )}
      </div>
      {/* VHS spine label */}
      <div className="border-t-[3px] border-ink bg-paper p-3">
        <h2 className="marker text-xl leading-tight" dir="auto">
          {title}
        </h2>
        {note && (
          <p className="mt-1 text-sm" dir="auto">
            {note}
          </p>
        )}
      </div>
    </article>
  )
}

export default function Videos() {
  const { event } = useStore()
  const videos = (event?.videos ?? []).map((v) => ({ ...v, id: youtubeId(v.url) })).filter((v) => v.id)

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <h1 className="heading">Video Rental</h1>
      <p className="max-w-2xl text-lg">Home videos, ceremonies and school plays. Be kind, rewind.</p>
      {videos.length === 0 ? (
        <div className="sticky-note max-w-md text-lg">No tapes on the shelf yet. Organizers: add YouTube links to the videos list in content/event.json.</div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {videos.map((v) => (
            <Tape key={v.id} id={v.id!} title={v.title} note={v.note} />
          ))}
        </div>
      )}
    </div>
  )
}
