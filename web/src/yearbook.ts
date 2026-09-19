import { faceUrl, type Person, type Scene, type Tag } from './api.ts'

/** Class photos people were tagged on. The generated portrait wall is left out: it is made from the profiles themselves. */
function classPhotos(scenes: Scene[]): Scene[] {
  return scenes.filter((s) => s.kind === 'group').reverse()
}

/** The picture on someone's yearbook tile: their own 90s photo, else their face on the newest class photo, else today's photo. */
export function tilePhoto(person: Person, scenes: Scene[]): string | null {
  if (person.thenPhoto) return person.thenPhoto
  for (const scene of classPhotos(scenes)) {
    const tag = scene.tags.find((t) => t.personId === person.id)
    if (tag) return faceUrl(tag)
  }
  return person.nowPhoto
}

/** Faces on the class photos that nobody has named yet, newest photo first. */
export function unknownFaces(scenes: Scene[]): Tag[] {
  return classPhotos(scenes).flatMap((s) => s.tags.filter((t) => t.personId == null))
}

/** One place someone shows up: which poster, and the class printed over their group. */
export interface Appearance {
  year: number | null
  classLabel: string | null
  tag: Tag
}

export interface Filters {
  query: string
  /** A poster's year, or null for any. */
  year: number | null
  classLabel: string | null
  gender: 'm' | 'f' | null
  sort: 'name' | 'class'
}

export const NO_FILTERS: Filters = { query: '', year: null, classLabel: null, gender: null, sort: 'name' }

export function isFiltering(f: Filters): boolean {
  return Boolean(f.query.trim()) || f.year != null || f.classLabel != null || f.gender != null
}

/** Everyone's faces on the class photos, newest photo first. */
export function appearancesByPerson(scenes: Scene[]): Map<number, Appearance[]> {
  const out = new Map<number, Appearance[]>()
  for (const scene of classPhotos(scenes)) {
    for (const tag of scene.tags) {
      if (tag.personId == null) continue
      const list = out.get(tag.personId) ?? []
      list.push({ year: scene.year, classLabel: tag.classLabel, tag })
      out.set(tag.personId, list)
    }
  }
  return out
}

/** Hebrew class names sort by grade and then by number: "ט'-2" before "ט'-10" before "י"ב-1". */
export function compareClass(a: string, b: string): number {
  const parts = (s: string) => {
    const [grade, number] = s.split('-')
    return { grade: grade.replace(/[^א-ת]/g, ''), number: Number(number) || 0 }
  }
  const GRADES = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י', 'יא', 'יב']
  const pa = parts(a)
  const pb = parts(b)
  const ga = GRADES.indexOf(pa.grade)
  const gb = GRADES.indexOf(pb.grade)
  if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb)
  return pa.number - pb.number || a.localeCompare(b, 'he')
}

/** The years that have a class photo, oldest first, each with its classes. Drives the filter menus. */
export function filterOptions(scenes: Scene[]): { year: number; classes: string[] }[] {
  const byYear = new Map<number, Set<string>>()
  for (const scene of scenes) {
    if (scene.kind !== 'group' || scene.year == null) continue
    const classes = byYear.get(scene.year) ?? new Set<string>()
    for (const tag of scene.tags) if (tag.classLabel) classes.add(tag.classLabel)
    byYear.set(scene.year, classes)
  }
  return [...byYear].sort(([a], [b]) => a - b).map(([year, classes]) => ({ year, classes: [...classes].sort(compareClass) }))
}

/** The appearance a filter is about: the chosen year and class, else the newest one. */
export function matchingAppearance(list: Appearance[] | undefined, f: Pick<Filters, 'year' | 'classLabel'>): Appearance | undefined {
  return list?.find((a) => (f.year == null || a.year === f.year) && (f.classLabel == null || a.classLabel === f.classLabel))
}

/**
 * Slices the roster. A year or class keeps the people who are on that poster or in that class, and the result
 * carries the matching appearance so the tile can show that year's face.
 */
export function filterPeople(
  people: Person[],
  scenes: Scene[],
  f: Filters,
  matches: (person: Person, query: string) => boolean,
): { person: Person; appearance: Appearance | undefined }[] {
  const appearances = appearancesByPerson(scenes)
  const rows = people.flatMap((person) => {
    if (f.query.trim() && !matches(person, f.query)) return []
    if (f.gender && person.gender !== f.gender) return []
    const appearance = matchingAppearance(appearances.get(person.id), f)
    if ((f.year != null || f.classLabel != null) && !appearance) return []
    return [{ person, appearance }]
  })
  const byName = (a: { person: Person }, b: { person: Person }) => surname(a.person.name).localeCompare(surname(b.person.name), 'he')
  if (f.sort === 'class') {
    return rows.sort((a, b) => {
      const ca = a.appearance?.classLabel
      const cb = b.appearance?.classLabel
      if (ca && cb) return (b.appearance!.year ?? 0) - (a.appearance!.year ?? 0) || compareClass(ca, cb) || byName(a, b)
      return (ca ? 0 : 1) - (cb ? 0 : 1) || byName(a, b)
    })
  }
  return rows.sort(byName)
}

/** Poster names are an initial and a surname ("י. ישראלי"), so those sort by the surname; full names sort as they are. */
function surname(name: string): string {
  return /^\S\.\s/.test(name) ? name.slice(name.indexOf(' ') + 1) + ' ' + name[0] : name
}
