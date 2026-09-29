import type { Scene } from './api.ts'

/** The yearbook address for a person, or for nobody, on a scene: `/p/<id>?s=<slug>`. */
export function yearbookPath(personId: number | null | undefined, slug: string | undefined): string {
  return `${personId ? `/p/${personId}` : '/'}${slug ? `?s=${slug}` : ''}`
}

export type Landing = { focus: number } | { redirect: [to: string, options: { replace: true }] }

/**
 * Opening a link to a person: fly to their face when the scene on screen shows them, otherwise move to a scene that
 * does. The move replaces the link in the history, so going back leaves the page instead of landing on the link again
 * and being moved forward once more. Null when no scene shows them.
 */
export function landOnPerson(personId: number, scene: Scene, scenes: readonly Scene[]): Landing | null {
  const tag = scene.tags.find((t) => t.personId === personId)
  if (tag) return { focus: tag.id }
  const other = scenes.find((s) => s.tags.some((t) => t.personId === personId))
  return other ? { redirect: [yearbookPath(personId, other.slug), { replace: true }] } : null
}
