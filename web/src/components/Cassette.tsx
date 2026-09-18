import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.tsx'

// Minimal slice of the YouTube IFrame Player API that we use.
interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  nextVideo(): void
  previousVideo(): void
  setVolume(volume: number): void
  getVideoData(): { title?: string }
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer }
    onYouTubeIframeAPIReady?: () => void
  }
}

const YT_PLAYING = 1

/** Lets other screens (like Videos) stop the mixtape before starting their own audio. */
export const mixtape = { pause: () => {} }

let apiPromise: Promise<void> | null = null
function loadYouTubeApi(): Promise<void> {
  apiPromise ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve()
    window.onYouTubeIframeAPIReady = () => resolve()
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(script)
  })
  return apiPromise
}

function Tape({ label, small }: { label: string; small?: boolean }) {
  return (
    <svg viewBox="0 0 300 190" className={small ? 'h-10 w-16' : 'w-full'} role="img" aria-label="Cassette tape">
      <rect x="4" y="4" width="292" height="182" rx="14" fill="#ec4899" stroke="#151515" strokeWidth="6" />
      <rect x="24" y="22" width="252" height="104" rx="8" fill="#fdf6e3" stroke="#151515" strokeWidth="5" />
      <path d="M24 50h252" stroke="#151515" strokeWidth="3" />
      <path d="M36 40h120" stroke="#14b8a6" strokeWidth="6" strokeLinecap="round" />
      {!small && (
        <text x="150" y="44" textAnchor="middle" fontFamily="Permanent Marker, Rubik, cursive" fontSize="17" fill="#151515">
          {label.length > 28 ? `${label.slice(0, 27)}...` : label}
        </text>
      )}
      <rect x="70" y="62" width="160" height="52" rx="26" fill="#151515" />
      <rect x="122" y="72" width="56" height="32" fill="#6b4a2f" stroke="#fdf6e3" strokeWidth="2" />
      {[100, 200].map((cx) => (
        <g key={cx} className="reel">
          <circle cx={cx} cy="88" r="20" fill="#fdf6e3" stroke="#151515" strokeWidth="3" />
          {[0, 60, 120].map((angle) => (
            <rect key={angle} x={cx - 2.5} y="70" width="5" height="36" fill="#151515" transform={`rotate(${angle} ${cx} 88)`} />
          ))}
          <circle cx={cx} cy="88" r="6" fill="#fdf6e3" stroke="#151515" strokeWidth="3" />
        </g>
      ))}
      <path d="M60 186l14-42h152l14 42" fill="#facc15" stroke="#151515" strokeWidth="5" strokeLinejoin="round" />
      <circle cx="96" cy="168" r="6" fill="#151515" />
      <circle cx="204" cy="168" r="6" fill="#151515" />
    </svg>
  )
}

/** The persistent mixtape player: a YouTube playlist wearing a cassette costume. */
export default function Cassette() {
  const { event } = useStore()
  const playlistId = event?.music.youtubePlaylistId ?? ''
  const mixtapeTitle = event?.music.mixtapeTitle ?? 'Class Mixtape'
  const mount = useRef<HTMLDivElement>(null)
  const player = useRef<YTPlayer | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [track, setTrack] = useState('')
  const [volume, setVolume] = useState(70)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!playlistId || !mount.current) return
    let cancelled = false
    const target = document.createElement('div')
    mount.current.appendChild(target)
    loadYouTubeApi().then(() => {
      if (cancelled || !window.YT) return
      player.current = new window.YT.Player(target, {
        width: 240,
        height: 135,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { listType: 'playlist', list: playlistId, playsinline: 1, rel: 0 },
        events: {
          onReady: () => setReady(true),
          onStateChange: (e: { data: number }) => {
            setPlaying(e.data === YT_PLAYING)
            setTrack(player.current?.getVideoData().title ?? '')
          },
        },
      })
    })
    mixtape.pause = () => player.current?.pauseVideo()
    return () => {
      cancelled = true
      mixtape.pause = () => {}
    }
  }, [playlistId])

  useEffect(() => {
    if (ready) player.current?.setVolume(volume)
  }, [ready, volume])

  const toggle = () => (playing ? player.current?.pauseVideo() : player.current?.playVideo())
  const deckButton = 'btn btn-plain btn-sm pixel min-w-11 text-xl leading-none'

  return (
    <aside
      className={`fixed bottom-16 left-3 z-30 sm:bottom-4 sm:left-4 ${playing ? 'playing' : ''}`}
      aria-label="Mixtape player"
    >
      <div className={`chunk w-72 max-w-[calc(100vw-1.5rem)] space-y-3 p-3 shadow-chunk-lg ${open ? '' : 'hidden'}`}>
        <Tape label={mixtapeTitle} />
        <div className="lcd truncate text-xl" dir="auto">
          {!playlistId ? 'NO TAPE LOADED' : !ready ? 'LOADING...' : track || 'PRESS PLAY'}
        </div>
        {/* YouTube asks that its player stays visible, so it plays on a tiny TV. */}
        <div ref={mount} className="overflow-hidden rounded-lg border-[3px] border-ink bg-ink [&_iframe]:block [&_iframe]:w-full" />
        {playlistId ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <button className={deckButton} onClick={() => player.current?.previousVideo()} disabled={!ready} aria-label="Previous track">
                {'|<'}
              </button>
              <button className={`${deckButton} flex-1 bg-sun`} onClick={toggle} disabled={!ready}>
                {playing ? 'PAUSE' : 'PLAY'}
              </button>
              <button className={deckButton} onClick={() => player.current?.nextVideo()} disabled={!ready} aria-label="Next track">
                {'>|'}
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm font-bold uppercase">
              Vol
              <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full accent-pink" />
            </label>
          </>
        ) : (
          <p className="text-sm">Add a YouTube playlist ID to load the mixtape.</p>
        )}
        <button className="btn btn-plain btn-sm w-full" onClick={() => setOpen(false)}>
          Eject (hide player)
        </button>
      </div>

      {!open && (
        <div className="chunk flex items-center gap-2 p-1.5 pr-2">
          <button onClick={() => setOpen(true)} aria-label="Open mixtape player" className="cursor-pointer">
            <Tape label="" small />
          </button>
          {playlistId && ready && (
            <button className="btn btn-sm pixel text-lg leading-none" onClick={toggle}>
              {playing ? 'PAUSE' : 'PLAY'}
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
