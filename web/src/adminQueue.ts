// The roster review queue is frozen while organizers work through it, but people in it can disappear: merged into
// someone else or hidden as staff. These step over them, so the review never lands on a person who is gone.

/** The first place at or after `index` whose person still exists, or `queue.length` when nobody is left. */
export function nextLive(queue: readonly number[], index: number, exists: (id: number) => boolean): number {
  let i = index
  while (i < queue.length && !exists(queue[i])) i++
  return i
}

/** The last place before `index` whose person still exists, or -1 when there is none. */
export function previousLive(queue: readonly number[], index: number, exists: (id: number) => boolean): number {
  let i = Math.min(index, queue.length) - 1
  while (i >= 0 && !exists(queue[i])) i--
  return i
}
