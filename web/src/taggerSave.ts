export type SaveResult<T> = { status: 'done'; value: T } | { status: 'not-saved'; error: string } | { status: 'not-reloaded'; value: T }

/**
 * A change in the tagger: save it, then reload the scene. A failed save carries the server's reason, so the canvas can
 * be put back. A failed reload does not: the server kept the change, so nothing is undone, and the browser's own error
 * text ("Failed to fetch") is not shown; the tagger says RELOAD_FAILED and offers to reload again.
 */
export async function saveThenReload<T>(save: () => Promise<T>, reload: () => Promise<unknown>): Promise<SaveResult<T>> {
  let value: T
  try {
    value = await save()
  } catch (err) {
    return { status: 'not-saved', error: (err as Error).message }
  }
  try {
    await reload()
  } catch {
    return { status: 'not-reloaded', value }
  }
  return { status: 'done', value }
}

export const RELOAD_FAILED = 'השינוי נשמר, אבל לא הצלחנו לרענן את התמונה, אז ייתכן שמה שמוצג כאן לא מעודכן.'

/** A failed reload says the change was kept only when something was saved; auto-detect that found no faces saves nothing. */
export function reloadFailedText(savedSomething: boolean): string {
  return savedSomething ? RELOAD_FAILED : 'לא הצלחנו לרענן את התמונה, אז ייתכן שמה שמוצג כאן לא מעודכן.'
}
