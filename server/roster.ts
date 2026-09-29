import type { Db, PersonRow, SceneRow, TagRow } from './db.ts'
import { deletePhoto, deletePhotos, getPerson, insertPerson, listPhotos, MAX_PHOTOS_PER_KIND, updatePerson } from './people.ts'

/**
 * The names, classes and genders worked out for the class photos, as one file. It is how a roster that was
 * reviewed on one copy of the site reaches another: faces are matched by picture and position, never by id.
 */
export interface RosterFile {
  version: 1
  people: { key: string; name: string; gender: 'm' | 'f' | null }[]
  scenes: {
    title: string
    year: number | null
    width: number
    height: number
    faces: { x: number; y: number; w: number; h: number; caption: string | null; classLabel: string | null; staff: boolean; person: string | null }[]
  }[]
}

export interface ImportResult {
  facesMatched: number
  facesUnmatched: number
  peopleAdded: number
  peopleUpdated: number
  /** Faces that already had a name here. Their name is left alone. */
  namesKept: number
}

function groupScenes(db: Db): SceneRow[] {
  return db.prepare(`SELECT * FROM scenes WHERE kind = 'group' ORDER BY sort, id`).all() as unknown as SceneRow[]
}

export function exportRoster(db: Db): RosterFile {
  const keys = new Set<number>()
  const scenes = groupScenes(db).map((scene) => {
    const tags = db.prepare('SELECT * FROM tags WHERE scene_id = ? ORDER BY id').all(scene.id) as unknown as TagRow[]
    return {
      title: scene.title,
      year: scene.year,
      width: scene.width,
      height: scene.height,
      faces: tags.map((t) => {
        if (t.person_id != null) keys.add(t.person_id)
        return {
          x: t.x, y: t.y, w: t.w, h: t.h,
          caption: t.caption, classLabel: t.class_label, staff: Boolean(t.is_staff),
          person: t.person_id == null ? null : `p${t.person_id}`,
        }
      }),
    }
  })
  const people = [...keys].map((id) => {
    const person = getPerson(db, id)!
    return { key: `p${id}`, name: person.name, gender: person.gender }
  })
  return { version: 1, people, scenes }
}

/** An initial, a dot and a surname, as printed under the faces. */
function isPosterName(name: string): boolean {
  return /^\S\.\s/.test(name)
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  return (w * h) / (a.w * a.h + b.w * b.h - w * h)
}

export function parseRoster(body: unknown): RosterFile {
  const file = body as RosterFile | null
  if (!file || file.version !== 1 || !Array.isArray(file.people) || !Array.isArray(file.scenes)) throw new Error('This is not a roster file')
  for (const p of file.people) {
    if (typeof p.key !== 'string' || typeof p.name !== 'string' || !p.name.trim()) throw new Error('Every person needs a key and a name')
    if (p.gender != null && p.gender !== 'm' && p.gender !== 'f') throw new Error('Invalid gender value')
  }
  for (const s of file.scenes) {
    if (!Array.isArray(s.faces) || !(s.width > 0)) throw new Error('Invalid picture in roster file')
    for (const f of s.faces) if (![f.x, f.y, f.w, f.h].every(Number.isFinite)) throw new Error('Invalid face box in roster file')
  }
  return file
}

/**
 * Applies a roster file. Safe to run again: a face that already has a name keeps it, and the file's person
 * is taken to be that same person. Claimed profiles and names that people typed are never renamed.
 */
export function importRoster(db: Db, file: RosterFile): ImportResult {
  const result: ImportResult = { facesMatched: 0, facesUnmatched: 0, peopleAdded: 0, peopleUpdated: 0, namesKept: 0 }
  const local = groupScenes(db)
  const matches: { tag: TagRow; face: RosterFile['scenes'][number]['faces'][number] }[] = []
  // A face here is matched at most once, and a picture here that the file already has is not taken again by
  // year: two pictures from one year must not both write to the same faces.
  const usedTags = new Set<number>()
  const matchedScenes = new Set(local.filter((s) => file.scenes.some((source) => source.title === s.title)).map((s) => s.id))

  for (const source of file.scenes) {
    const scene =
      local.find((s) => s.title === source.title) ??
      (source.year == null ? undefined : local.find((s) => s.year === source.year && !matchedScenes.has(s.id)))
    if (!scene) {
      result.facesUnmatched += source.faces.length
      continue
    }
    matchedScenes.add(scene.id)
    const scale = scene.width / source.width
    const tags = db.prepare('SELECT * FROM tags WHERE scene_id = ?').all(scene.id) as unknown as TagRow[]
    const pairs = source.faces.flatMap((face) => {
      const box = { x: face.x * scale, y: face.y * scale, w: face.w * scale, h: face.h * scale }
      return tags.map((tag) => ({ face, tag, score: overlap(box, tag) })).filter((p) => p.score > 0.3)
    })
    pairs.sort((a, b) => b.score - a.score)
    const usedFaces = new Set<unknown>()
    for (const pair of pairs) {
      if (usedFaces.has(pair.face) || usedTags.has(pair.tag.id)) continue
      usedFaces.add(pair.face)
      usedTags.add(pair.tag.id)
      matches.push(pair)
    }
    result.facesUnmatched += source.faces.length - usedFaces.size
  }
  result.facesMatched = matches.length

  db.exec('BEGIN')
  try {
    // A face that is already named here tells us who the file's person is on this site.
    const personFor = new Map<string, number>()
    for (const { tag, face } of matches) {
      if (face.person && !face.staff && tag.person_id != null && !personFor.has(face.person)) personFor.set(face.person, tag.person_id)
    }
    const people = new Map(file.people.map((p) => [p.key, p]))
    for (const [key, id] of personFor) {
      const incoming = people.get(key)
      const existing = getPerson(db, id)
      if (!incoming || !existing) continue
      const fields: Record<string, string | null> = {}
      // Only a name that is itself a poster caption ("X. surname") gives way. A name a person typed always stays.
      if (!existing.claimed_at && isPosterName(existing.name) && existing.name !== incoming.name.trim()) fields.name = incoming.name.trim()
      if (!existing.gender && incoming.gender) fields.gender = incoming.gender
      if (Object.keys(fields).length) (updatePerson(db, id, fields), result.peopleUpdated++)
    }

    // A caption or class the file does not have leaves the one typed here alone.
    const update = db.prepare('UPDATE tags SET caption = COALESCE(?, caption), class_label = COALESCE(?, class_label), is_staff = ?, person_id = ? WHERE id = ?')
    for (const { tag, face } of matches) {
      let personId = tag.person_id
      let staff = face.staff ? 1 : 0
      // A name given here wins over the file, even over a staff mark.
      if (personId != null) (result.namesKept++, (staff = tag.is_staff))
      else if (face.staff) personId = null
      else if (face.person && people.has(face.person)) {
        if (!personFor.has(face.person)) {
          const incoming = people.get(face.person)!
          personFor.set(face.person, insertPerson(db, { name: incoming.name.trim(), gender: incoming.gender }))
          result.peopleAdded++
        }
        personId = personFor.get(face.person)!
      }
      update.run(face.caption?.trim() || null, face.classLabel?.trim() || null, staff, personId, tag.id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return result
}

/** Details the kept profile takes from the merged one when it has none of its own, each with the flag that hides it. */
const MERGED_FIELDS = [
  ['former_name', null],
  ['nickname', null],
  ['email', 'show_email'],
  ['phone', 'show_phone'],
  ['instagram', 'show_instagram'],
  ['linkedin', 'show_linkedin'],
  ['facebook', 'show_facebook'],
  ['x', 'show_x'],
  ['website', 'show_website'],
] as const

/**
 * Folds one unclaimed profile into another: the same person read two ways on two posters. The kept profile's
 * own photos stay first; the other one's fill any free places up to the limit, and the files of the rest are deleted.
 */
export function mergePeople(db: Db, dataDir: string, from: PersonRow, into: PersonRow) {
  if (from.id === into.id) throw new Error('Cannot merge a profile into itself')
  if (from.claimed_at) throw new Error('A claimed profile cannot be merged away. Merge the other one into it.')
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE tags SET person_id = ? WHERE person_id = ?').run(into.id, from.id)
    db.prepare('UPDATE notes SET recipient_id = ? WHERE recipient_id = ?').run(into.id, from.id)
    const fields: Record<string, string | number | null> = {}
    if (!into.gender && from.gender) fields.gender = from.gender
    for (const [field, flag] of MERGED_FIELDS) {
      if (into[field] || !from[field]) continue
      fields[field] = from[field]
      // Hidden on either profile stays hidden.
      if (flag) fields[flag] = into[flag] && from[flag] ? 1 : 0
    }
    updatePerson(db, into.id, fields)
    for (const kind of ['then', 'now'] as const) {
      const room = MAX_PHOTOS_PER_KIND - listPhotos(db, into.id, kind).length
      for (const [i, photo] of listPhotos(db, from.id, kind).entries()) {
        // A new row sorts after the kept profile's own photos. The old row goes with the merged profile.
        if (i < room) {
          db.prepare('INSERT INTO person_photos (person_id, kind, path, created_at) SELECT ?, kind, path, created_at FROM person_photos WHERE id = ?')
            .run(into.id, photo.id)
        } else deletePhoto(db, dataDir, from.id, photo.id)
      }
      // The mirror people.ts keeps for the portrait wall: the oldest photo of each kind.
      const column = kind === 'then' ? 'then_photo' : 'now_photo'
      db.prepare(`UPDATE people SET ${column} = (SELECT path FROM person_photos WHERE person_id = ? AND kind = ? ORDER BY id LIMIT 1) WHERE id = ?`)
        .run(into.id, kind, into.id)
    }
    db.prepare('DELETE FROM people WHERE id = ?').run(from.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Marks someone as staff: their faces are hidden and keep the name as a caption, and the unclaimed profile goes. */
export function markPersonStaff(db: Db, dataDir: string, person: PersonRow) {
  if (person.claimed_at) throw new Error('A claimed profile cannot be marked as staff')
  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE tags SET is_staff = 1, caption = COALESCE(caption, ?), person_id = NULL
       WHERE person_id = ? AND scene_id IN (SELECT id FROM scenes WHERE kind = 'group')`,
    ).run(person.name, person.id)
    deletePhotos(db, dataDir, person.id)
    db.prepare('DELETE FROM people WHERE id = ?').run(person.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
