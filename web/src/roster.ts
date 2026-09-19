import type { Person, Scene } from './api.ts'

/** Letters only, final forms folded, so "ד. אלמונני" and "ד.אלמוני" can be compared. */
export function nameKey(name: string): string {
  const FINALS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }
  return name.replace(/[^\p{L}]/gu, '').replace(/[ךםןףץ]/g, (ch) => FINALS[ch]).toLowerCase()
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    prev = cur
  }
  return prev[b.length]
}

/**
 * Pairs of unclaimed-or-not profiles that may be one person read two ways: the same initial, nearly the same
 * surname, and never on the same poster (two people on one poster are two people).
 */
export function possibleDuplicates(people: Person[], scenes: Scene[]): [Person, Person][] {
  const years = new Map<number, Set<number>>()
  for (const scene of scenes) {
    if (scene.kind !== 'group') continue
    for (const tag of scene.tags) if (tag.personId != null) years.set(tag.personId, (years.get(tag.personId) ?? new Set()).add(scene.id))
  }
  const keyed = people.map((person) => ({ person, key: nameKey(person.name) })).filter((p) => p.key.length >= 4 && years.has(p.person.id))
  const pairs: [Person, Person][] = []
  for (const [i, a] of keyed.entries()) {
    for (const b of keyed.slice(i + 1)) {
      if (a.key[0] !== b.key[0] || Math.abs(a.key.length - b.key.length) > 2) continue
      const shared = [...years.get(a.person.id)!].some((id) => years.get(b.person.id)!.has(id))
      if (!shared && editDistance(a.key, b.key) <= 2) pairs.push([a.person, b.person])
    }
  }
  return pairs
}
