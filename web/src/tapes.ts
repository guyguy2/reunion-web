import type { Tape } from './api.ts'

/** The organizers' playlist from the event config, if set, is always the first tape (id 0), ahead of classmates' tapes. */
export function buildShelf(houseId: string, houseTitle: string, added: Tape[]): Tape[] {
  if (!houseId) return added
  const house: Tape = {
    id: 0,
    provider: 'youtube',
    kind: 'playlist',
    externalId: houseId,
    title: houseTitle,
    addedBy: null,
    url: `https://www.youtube.com/playlist?list=${houseId}`,
  }
  return [house, ...added]
}

/** The chosen tape, or the first one when nothing is chosen yet or the chosen tape was removed. */
export function pickTape(tapes: Tape[], id: number | null): Tape | null {
  return tapes.find((t) => t.id === id) ?? tapes[0] ?? null
}

/** Only YouTube playlists get the deck's previous/next buttons; Spotify's embed has its own. */
export function canSkip(tape: Pick<Tape, 'provider' | 'kind'> | null): boolean {
  return tape?.provider === 'youtube' && tape.kind === 'playlist'
}

export function spotifyUri(tape: Pick<Tape, 'kind' | 'externalId'>): string {
  return `spotify:${tape.kind}:${tape.externalId}`
}

/** The tape after this one, wrapping around to the start so the mixtape keeps going. Null when there is nothing else to play. */
export function nextTape(tapes: Tape[], current: Tape | null): Tape | null {
  if (!current || tapes.length < 2) return null
  const index = tapes.findIndex((t) => t.id === current.id)
  return tapes[(index + 1) % tapes.length]
}

/** A single video is done when it ends; a playlist only once its last video ends (YouTube plays the rest by itself). */
export function tapeFinished(kind: string, playlistIndex: number, playlistLength: number): boolean {
  return kind !== 'playlist' || playlistIndex >= playlistLength - 1
}
