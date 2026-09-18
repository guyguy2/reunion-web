import { useStore } from '../store.tsx'

const PRINTS = [
  { rotate: '-rotate-6', color: 'bg-teal', caption: 'Prom?' },
  { rotate: 'rotate-3', color: 'bg-pink', caption: 'Field trip' },
  { rotate: '-rotate-2', color: 'bg-grape', caption: 'Last day!!' },
]

export default function Memories() {
  const { event } = useStore()
  const memories = event?.memories

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 sm:p-8">
      <h1 className="heading">Memory Board</h1>

      {/* A one-hour-photo envelope with a few prints sticking out. */}
      <div className="chunk relative overflow-hidden bg-sun p-6 shadow-chunk-lg sm:p-10">
        <div className="pixel absolute top-3 right-4 text-xl">1-HOUR PHOTO / 24 EXP.</div>
        <div className="mt-6 flex justify-center gap-3 sm:gap-6" aria-hidden>
          {PRINTS.map((print) => (
            <div key={print.caption} className={`polaroid w-24 sm:w-36 ${print.rotate}`}>
              <div className={`aspect-square ${print.color}`} />
              <p className="marker -mb-6 pt-1 text-center text-sm">{print.caption}</p>
            </div>
          ))}
        </div>
        <h2 className="mt-8 font-display text-2xl">{memories?.albumTitle ?? 'Shared album'}</h2>
        <p className="mt-2 max-w-2xl text-lg">{memories?.blurb}</p>
        {memories?.albumUrl ? (
          <div className="mt-5 flex flex-wrap gap-3">
            <a className="btn btn-pink" href={memories.albumUrl} target="_blank" rel="noreferrer">
              Open the album
            </a>
            <a className="btn btn-plain" href={memories.albumUrl} target="_blank" rel="noreferrer">
              Add your photos
            </a>
          </div>
        ) : (
          <p className="mt-4 font-bold">The album link has not been set up yet.</p>
        )}
        <p className="mt-4 text-sm">
          The album lives on Google Photos and opens in a new tab. To add pictures, open it while signed in to a Google account and use the add-photos button.
        </p>
      </div>
    </div>
  )
}
