import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, type Tape as ShelfTape } from '../api.ts'
import { useStore } from '../store.tsx'
import { buildShelf, canSkip, nextTape, pickTape, spotifyUri, tapeFinished } from '../tapes.ts'
import { LAYER, useEscape } from '../useEscape.ts'

// Minimal slice of the YouTube IFrame Player API that we use.
interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  nextVideo(): void
  previousVideo(): void
  setVolume(volume: number): void
  getVideoData(): { title?: string }
  getPlaylist(): string[] | null
  getPlaylistIndex(): number
  destroy(): void
}
// Minimal slice of Spotify's iFrame API. It has no volume or next/previous; the embed shows its own controls.
interface SpotifyController {
  togglePlay(): void
  pause(): void
  destroy(): void
  addListener(event: 'ready', cb: () => void): void
  addListener(event: 'playback_update', cb: (e: { data: { isPaused: boolean } }) => void): void
}
interface SpotifyIFrameApi {
  createController(el: HTMLElement, opts: { uri: string; width: string; height: number }, cb: (c: SpotifyController) => void): void
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer }
    onYouTubeIframeAPIReady?: () => void
    onSpotifyIframeApiReady?: (api: SpotifyIFrameApi) => void
  }
}

const YT_ENDED = 0
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

let spotifyPromise: Promise<SpotifyIFrameApi> | null = null
function loadSpotifyApi(): Promise<SpotifyIFrameApi> {
  spotifyPromise ??= new Promise((resolve) => {
    window.onSpotifyIframeApiReady = resolve
    const script = document.createElement('script')
    script.src = 'https://open.spotify.com/embed/iframe-api/v1'
    document.head.appendChild(script)
  })
  return spotifyPromise
}

/** What the deck buttons talk to, whichever service is playing the tape. */
interface Deck {
  toggle(playing: boolean): void
  pause(): void
  next?(): void
  previous?(): void
  setVolume?(volume: number): void
  destroy(): void
}

function Tape({ label, small }: { label: string; small?: boolean }) {
  return (
    <svg viewBox="0 0 300 190" className={small ? 'h-10 w-16' : 'w-full'} role="img" aria-label="קלטת">
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

/** The persistent mixtape player: a shelf of YouTube and Spotify tapes wearing a cassette costume. */
export default function Cassette() {
  const { event, role, me } = useStore()
  const houseId = event?.music.youtubePlaylistId ?? ''
  const houseTitle = event?.music.mixtapeTitle ?? 'קלטת המחזור'
  const [shelf, setShelf] = useState<ShelfTape[]>([])
  const [tapeId, setTapeId] = useState<number | null>(null)
  const mount = useRef<HTMLDivElement>(null)
  const deck = useRef<Deck | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [track, setTrack] = useState('')
  const [volume, setVolume] = useState(70)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ url: '', title: '', addedBy: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const tapes = useMemo(() => buildShelf(houseId, houseTitle, shelf), [houseId, houseTitle, shelf])
  const tape = pickTape(tapes, tapeId)
  const { provider, kind, externalId } = tape ?? {}
  const isSpotify = provider === 'spotify'

  // When a tape finishes, the next one loads and starts playing. Refs, because the player's callbacks outlive renders.
  const autoplayNext = useRef(false)
  const advance = useRef(() => {})
  advance.current = () => {
    const next = nextTape(tapes, tape)
    if (!next) return
    autoplayNext.current = true
    setTapeId(next.id)
  }

  const loadShelf = useCallback(() => api<ShelfTape[]>('/api/tapes').then(setShelf).catch(() => {}), [])
  useEffect(() => {
    loadShelf()
  }, [loadShelf])

  useEffect(() => {
    const el = mount.current
    if (!provider || !kind || !externalId || !el) return
    let cancelled = false
    let current: Deck | null = null
    const attach = (d: Deck) => {
      if (cancelled) return d.destroy()
      current = deck.current = d
    }
    const target = document.createElement('div')
    el.appendChild(target)
    setReady(false)
    setPlaying(false)
    setTrack('')
    const autoplay = autoplayNext.current
    autoplayNext.current = false
    if (provider === 'youtube') {
      loadYouTubeApi().then(() => {
        if (cancelled || !window.YT) return
        const player: YTPlayer = new window.YT.Player(target, {
          width: 240,
          height: 135,
          host: 'https://www.youtube-nocookie.com',
          ...(kind === 'video' ? { videoId: externalId } : {}),
          playerVars: { ...(kind === 'playlist' ? { listType: 'playlist', list: externalId } : {}), playsinline: 1, rel: 0 },
          events: {
            onReady: () => {
              setReady(true)
              if (autoplay) player.playVideo()
            },
            onStateChange: (e: { data: number }) => {
              setPlaying(e.data === YT_PLAYING)
              setTrack(player.getVideoData().title ?? '')
              if (e.data === YT_ENDED && tapeFinished(kind, player.getPlaylistIndex(), player.getPlaylist()?.length ?? 0)) {
                advance.current()
              }
            },
          },
        })
        attach({
          toggle: (on) => (on ? player.pauseVideo() : player.playVideo()),
          pause: () => player.pauseVideo(),
          next: () => player.nextVideo(),
          previous: () => player.previousVideo(),
          setVolume: (v) => player.setVolume(v),
          destroy: () => player.destroy(),
        })
      })
    } else {
      loadSpotifyApi().then((spotify) => {
        if (cancelled) return
        spotify.createController(target, { uri: spotifyUri({ kind, externalId }), width: '100%', height: 152 }, (controller) => {
          // A cached embed can fire 'ready' before this callback runs, so a live controller counts as ready.
          controller.addListener('ready', () => setReady(true))
          controller.addListener('playback_update', (e) => setPlaying(!e.data.isPaused))
          attach({ toggle: () => controller.togglePlay(), pause: () => controller.pause(), destroy: () => controller.destroy() })
          if (!cancelled) setReady(true)
        })
      })
    }
    mixtape.pause = () => deck.current?.pause()
    return () => {
      cancelled = true
      current?.destroy()
      deck.current = null
      el.replaceChildren()
      mixtape.pause = () => {}
    }
  }, [provider, kind, externalId])

  useEffect(() => {
    if (ready) deck.current?.setVolume?.(volume)
  }, [ready, volume])

  const toggle = () => deck.current?.toggle(playing)

  useEscape(open && (() => (adding ? setAdding(false) : setOpen(false))), LAYER.drawer)

  const startAdding = () => {
    setForm((f) => ({ ...f, addedBy: f.addedBy || me?.name || '' }))
    setError('')
    setAdding(true)
  }

  const addTape = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const added = await api<ShelfTape>('/api/tapes', { json: form })
      await loadShelf()
      setTapeId(added.id)
      setForm((f) => ({ ...f, url: '', title: '' }))
      setAdding(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const removeTape = async (id: number) => {
    setConfirmRemove(false)
    try {
      await api(`/api/admin/tapes/${id}`, { method: 'DELETE' })
      setTapeId(null)
      await loadShelf()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const deckButton = 'btn btn-plain btn-sm pixel min-w-11 text-xl leading-none'

  return (
    <aside
      className={`fixed start-3 bottom-16 z-30 sm:start-4 sm:bottom-4 ${playing ? 'playing' : ''}`}
      aria-label="נגן הקלטת"
    >
      <div className={`chunk max-h-[calc(100dvh-5.5rem)] w-80 max-w-[calc(100vw-1.5rem)] space-y-3 overflow-y-auto p-3 shadow-chunk-lg ${open ? '' : 'hidden'}`}>
        <Tape label={tape?.title ?? houseTitle} />
        <div className="lcd truncate text-xl" dir="auto">
          {!tape ? 'אין קלטת' : !ready ? 'טוען...' : isSpotify ? tape.title : track || 'לחצו על נגן'}
        </div>
        {/* YouTube asks that its player stays visible, so it plays on a tiny TV. Spotify brings its own controls. */}
        <div ref={mount} className={`overflow-hidden rounded-lg border-[3px] border-ink bg-ink [&_iframe]:block [&_iframe]:w-full ${tape ? '' : 'hidden'}`} />
        {tape && (
          <>
            <div className="flex items-center justify-between gap-2" dir="ltr">
              {canSkip(tape) && (
                <button className={deckButton} onClick={() => deck.current?.previous?.()} disabled={!ready} aria-label="השיר הקודם">
                  {'|<'}
                </button>
              )}
              <button className={`${deckButton} flex-1 bg-sun`} onClick={toggle} disabled={!ready}>
                {playing ? 'עצור' : 'נגן'}
              </button>
              {canSkip(tape) && (
                <button className={deckButton} onClick={() => deck.current?.next?.()} disabled={!ready} aria-label="השיר הבא">
                  {'>|'}
                </button>
              )}
            </div>
            {!isSpotify && (
              <label className="flex items-center gap-2 text-sm font-bold uppercase">
                עוצמה
                <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full accent-pink" />
              </label>
            )}
            {isSpotify && <p className="text-xs">מחוברים לספוטיפיי בדפדפן הזה? השירים יתנגנו במלואם. אחרת ספוטיפיי מנגנת רק 30 שניות מכל שיר.</p>}
          </>
        )}

        {tapes.length > 1 && (
          <div>
            <label className="label" htmlFor="tape-pick">
              מדף הקלטות
            </label>
            <select
              id="tape-pick"
              className="field py-1 text-sm"
              dir="auto"
              value={tape?.id}
              onChange={(e) => (setTapeId(Number(e.target.value)), setConfirmRemove(false))}
            >
              {tapes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({t.provider === 'spotify' ? 'ספוטיפיי' : 'יוטיוב'}){t.addedBy ? ` - ${t.addedBy}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        {tape?.addedBy && tapes.length <= 1 && <p className="text-sm">הוסיף/ה: {tape.addedBy}</p>}
        {role === 'admin' && tape && tape.id > 0 && (
          <div className="flex gap-1">
            {confirmRemove ? (
              <>
                <button className="btn btn-pink btn-sm" onClick={() => removeTape(tape.id)}>
                  להסיר באמת
                </button>
                <button className="btn btn-plain btn-sm" onClick={() => setConfirmRemove(false)}>
                  ביטול
                </button>
              </>
            ) : (
              <button className="btn btn-plain btn-sm text-pink" onClick={() => setConfirmRemove(true)}>
                הסרת הקלטת מהמדף
              </button>
            )}
          </div>
        )}

        {adding ? (
          <form onSubmit={addTape} className="space-y-2 rounded-lg border-[3px] border-dashed border-ink p-2">
            <label className="label" htmlFor="tape-url">
              קישור לשיר, סרטון, אלבום או פלייליסט
            </label>
            <input
              id="tape-url"
              className="field text-sm"
              dir="ltr"
              inputMode="url"
              autoFocus
              required
              placeholder="YouTube / YouTube Music / Spotify"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
            <label className="label" htmlFor="tape-title">
              שם הקלטת (לא חובה)
            </label>
            <input
              id="tape-title"
              className="field text-sm"
              dir="auto"
              maxLength={60}
              placeholder="ריק = השם מיוטיוב או מספוטיפיי"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <label className="label" htmlFor="tape-by">
              מי מוסיף/ה? (לא חובה)
            </label>
            <input id="tape-by" className="field text-sm" dir="auto" maxLength={60} value={form.addedBy} onChange={(e) => setForm({ ...form, addedBy: e.target.value })} />
            {error && <p className="text-sm font-bold text-pink">{error}</p>}
            <div className="flex gap-2">
              <button className="btn btn-sm flex-1" disabled={saving || !form.url.trim()}>
                {saving ? 'מוסיפים...' : 'הוספה למדף'}
              </button>
              <button type="button" className="btn btn-plain btn-sm" onClick={() => setAdding(false)}>
                ביטול
              </button>
            </div>
          </form>
        ) : (
          <>
            {!tape && <p className="text-sm">אין עדיין קלטות. הדביקו קישור מיוטיוב או מספוטיפיי כדי להוסיף את הראשונה.</p>}
            {error && <p className="text-sm font-bold text-pink">{error}</p>}
            <button className="btn btn-teal btn-sm w-full" onClick={startAdding}>
              + הוספת קלטת
            </button>
          </>
        )}
        <button className="btn btn-plain btn-sm w-full" onClick={() => setOpen(false)}>
          הוצאת הקלטת (הסתרת הנגן)
        </button>
      </div>

      {!open && (
        <div className="chunk flex items-center gap-2 p-1.5 pr-2">
          <button onClick={() => setOpen(true)} aria-label="פתיחת נגן הקלטת" className="cursor-pointer">
            <Tape label="" small />
          </button>
          {tape && ready && (
            <button className="btn btn-sm pixel text-lg leading-none" onClick={toggle}>
              {playing ? 'עצור' : 'נגן'}
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
