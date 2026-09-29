/**
 * Which actions on the admin page are running, by name, each with its own count. One action finishing leaves the
 * others busy, and two runs of the same kind (two deletes) stay busy until both are done. Use these in functional
 * state updates, so an action that ends doesn't overwrite one that started meanwhile.
 */
export type Busy = Readonly<Record<string, number>>

export function started(busy: Busy, action: string): Busy {
  return { ...busy, [action]: (busy[action] ?? 0) + 1 }
}

export function finished(busy: Busy, action: string): Busy {
  const { [action]: count = 0, ...rest } = busy
  return count > 1 ? { ...rest, [action]: count - 1 } : rest
}

export function isBusy(busy: Busy, action: string): boolean {
  return (busy[action] ?? 0) > 0
}
