import type { Db, SceneRow, TagRow } from './db.ts'
import { buildWall, cropFace, removeSceneFiles, tileScene, type Box, type WallPerson } from './images.ts'
import { listPeople } from './people.ts'

export function listScenes(db: Db) {
  const scenes = db.prepare('SELECT * FROM scenes ORDER BY sort, id').all() as unknown as SceneRow[]
  const tags = db.prepare('SELECT * FROM tags ORDER BY id').all() as unknown as TagRow[]
  return scenes.map((scene) => ({
    id: scene.id,
    slug: scene.slug,
    title: scene.title,
    kind: scene.kind,
    width: scene.width,
    height: scene.height,
    dzi: `/media/${scene.tiles_path}/scene.dzi`,
    tags: tags.filter((t) => t.scene_id === scene.id).map(serializeTag),
  }))
}

export function serializeTag(tag: TagRow) {
  return { id: tag.id, sceneId: tag.scene_id, personId: tag.person_id, x: tag.x, y: tag.y, w: tag.w, h: tag.h }
}

export function getScene(db: Db, id: number): SceneRow | undefined {
  return db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow | undefined
}

function slugify(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene'
  return `${base}-${Date.now().toString(36)}`
}

export async function addGroupScene(db: Db, dataDir: string, title: string, image: Buffer) {
  const slug = slugify(title)
  const tiled = await tileScene(dataDir, slug, image)
  const result = db
    .prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort) VALUES (?, ?, 'group', ?, ?, ?, 1)`)
    .run(slug, title, tiled.width, tiled.height, tiled.tilesPath)
  return Number(result.lastInsertRowid)
}

export function deleteScene(db: Db, dataDir: string, scene: SceneRow) {
  db.prepare('DELETE FROM scenes WHERE id = ?').run(scene.id)
  removeSceneFiles(dataDir, scene.tiles_path)
}

export function insertTag(db: Db, sceneId: number, box: Box, personId: number | null): number {
  const result = db
    .prepare('INSERT INTO tags (scene_id, person_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sceneId, personId, box.x, box.y, box.w, box.h)
  return Number(result.lastInsertRowid)
}

/** Regenerates the portrait wall from everyone's "then" photo. Tiles go to a fresh directory so browsers never see stale cached tiles. */
export async function rebuildWall(db: Db, dataDir: string) {
  const people: WallPerson[] = listPeople(db)
  const previous = db.prepare(`SELECT * FROM scenes WHERE kind = 'mosaic'`).all() as unknown as SceneRow[]
  if (people.length === 0) {
    for (const scene of previous) deleteScene(db, dataDir, scene)
    return null
  }
  // No uploaded then-photo? Fall back to the person's face on the most recent class photo.
  const latestFace = db.prepare(
    `SELECT t.*, s.tiles_path FROM tags t JOIN scenes s ON s.id = t.scene_id
     WHERE t.person_id = ? AND s.kind = 'group' ORDER BY s.id DESC LIMIT 1`,
  )
  for (const person of people) {
    if (person.then_photo) continue
    const face = latestFace.get(person.id) as unknown as (TagRow & { tiles_path: string }) | undefined
    if (face) person.fallback = await cropFace(dataDir, face.tiles_path, face).catch(() => null)
  }
  const { image, boxes } = await buildWall(dataDir, people)
  const tiled = await tileScene(dataDir, `wall-${Date.now().toString(36)}`, image)
  db.exec('BEGIN')
  try {
    for (const scene of previous) db.prepare('DELETE FROM scenes WHERE id = ?').run(scene.id)
    const result = db
      .prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path, sort) VALUES ('wall', 'The Wall', 'mosaic', ?, ?, ?, 99)`)
      .run(tiled.width, tiled.height, tiled.tilesPath)
    const sceneId = Number(result.lastInsertRowid)
    people.forEach((person, i) => insertTag(db, sceneId, boxes[i], person.id))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    removeSceneFiles(dataDir, tiled.tilesPath)
    throw err
  }
  for (const scene of previous) removeSceneFiles(dataDir, scene.tiles_path)
  return tiled
}
