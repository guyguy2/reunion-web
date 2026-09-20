import { Hono } from 'hono'
import type { Config } from './config.ts'
import { getCounter, type Db, type TagRow } from './db.ts'
import { requireAdmin, type AppEnv } from './auth.ts'
import { MAX_SCENE_BYTES, MAX_UPLOAD_BYTES, readImageField } from './images.ts'
import { addPhoto, deletePhoto, deletePhotos, getPerson, insertPerson, parseCsv, parsePersonInput, serializePerson, updatePerson } from './people.ts'
import { addGroupScene, deleteScene, getScene, insertTag, listScenes, rebuildWall, serializeTag } from './scenes.ts'
import { loadDemoData } from './demo.ts'
import { listFeedback } from './feedback.ts'
import { exportRoster, importRoster, markPersonStaff, mergePeople, parseRoster } from './roster.ts'

function parseBox(body: Record<string, unknown>) {
  const box = { x: Number(body.x), y: Number(body.y), w: Number(body.w), h: Number(body.h) }
  if (!Object.values(box).every(Number.isFinite) || box.w <= 0 || box.h <= 0) throw new Error('Invalid box')
  return box
}

export function adminRoutes(config: Config, db: Db) {
  const admin = new Hono<AppEnv>()
  admin.use('*', requireAdmin)

  // ---- People ----
  admin.post('/people', async (c) => {
    try {
      const fields = parsePersonInput(await c.req.json().catch(() => null), { admin: true })
      if (!fields.name) throw new Error('חובה למלא שם')
      return c.json(serializePerson(getPerson(db, insertPerson(db, fields))!, 'full'), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  admin.patch('/people/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!getPerson(db, id)) return c.json({ error: 'Not found' }, 404)
    try {
      updatePerson(db, id, parsePersonInput(await c.req.json().catch(() => null), { admin: true }))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json(serializePerson(getPerson(db, id)!, 'full'))
  })

  admin.delete('/people/:id', (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    if (!person) return c.json({ error: 'Not found' }, 404)
    deletePhotos(db, config.dataDir, person.id)
    db.prepare('DELETE FROM people WHERE id = ?').run(person.id)
    return c.json({ ok: true })
  })

  admin.post('/people/:id/reset-claim', (c) => {
    // Signs out every device too: the code and all device keys go with the claim.
    const id = Number(c.req.param('id'))
    db.prepare('UPDATE people SET claimed_at = NULL, edit_token_hash = NULL, pin_hash = NULL WHERE id = ?').run(id)
    db.prepare('DELETE FROM device_tokens WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM recovery_tokens WHERE person_id = ?').run(id)
    return c.json({ ok: true })
  })

  // Two profiles that turned out to be one person, e.g. a surname spelled two ways on two posters.
  admin.post('/people/:id/merge', async (c) => {
    const from = getPerson(db, Number(c.req.param('id')))
    const body = await c.req.json().catch(() => ({}))
    const into = getPerson(db, Number(body.intoId))
    if (!from || !into) return c.json({ error: 'Not found' }, 404)
    try {
      mergePeople(db, from, into)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json(serializePerson(getPerson(db, into.id)!, 'full'))
  })

  // A teacher who got a profile: hide their faces and drop the profile.
  admin.post('/people/:id/staff', (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    if (!person) return c.json({ error: 'Not found' }, 404)
    try {
      markPersonStaff(db, person)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json({ ok: true })
  })

  admin.post('/people/:id/photo/:kind', async (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    const kind = c.req.param('kind')
    if (!person) return c.json({ error: 'Not found' }, 404)
    if (kind !== 'then' && kind !== 'now') return c.json({ error: 'Unknown photo kind' }, 400)
    try {
      await addPhoto(db, config.dataDir, person.id, kind, await readImageField(c, 'photo', MAX_UPLOAD_BYTES))
    } catch (err) {
      return c.json({ error: (err as Error).message || 'לא הצלחנו לקרוא את התמונה' }, 400)
    }
    return c.json(serializePerson(getPerson(db, person.id)!, 'full'))
  })

  admin.delete('/people/:id/photo/:photoId', (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    if (!person) return c.json({ error: 'Not found' }, 404)
    if (!deletePhoto(db, config.dataDir, person.id, Number(c.req.param('photoId')))) return c.json({ error: 'Not found' }, 404)
    return c.json(serializePerson(getPerson(db, person.id)!, 'full'))
  })

  // CSV columns: name (required), former_name, nickname, email, instagram, linkedin, facebook, x, website, phone, city
  admin.post('/import-csv', async (c) => {
    const rows = parseCsv(await c.req.text())
    let added = 0
    const skipped: string[] = []
    for (const [i, row] of rows.entries()) {
      try {
        const fields = parsePersonInput(row, { admin: true })
        if (!fields.name) throw new Error('חובה למלא שם')
        insertPerson(db, fields)
        added++
      } catch (err) {
        skipped.push(`שורה ${i + 2}: ${(err as Error).message}`)
      }
    }
    return c.json({ added, skipped })
  })

  // ---- Scenes and tags ----
  // Unlike GET /api/scenes, this one includes the hidden staff faces.
  admin.get('/scenes', (c) => c.json(listScenes(db, { staff: true })))

  admin.post('/scenes', async (c) => {
    const body = await c.req.parseBody()
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 80) : 'תמונה קבוצתית'
    try {
      const id = await addGroupScene(db, config.dataDir, title, await readImageField(c, 'image', MAX_SCENE_BYTES))
      return c.json(listScenes(db).find((s) => s.id === id), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message || 'לא הצלחנו לעבד את התמונה' }, 400)
    }
  })

  admin.delete('/scenes/:id', (c) => {
    const scene = getScene(db, Number(c.req.param('id')))
    if (!scene) return c.json({ error: 'Not found' }, 404)
    deleteScene(db, config.dataDir, scene)
    return c.json({ ok: true })
  })

  admin.post('/scenes/:id/tags', async (c) => {
    const scene = getScene(db, Number(c.req.param('id')))
    if (!scene) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    try {
      const personId = body.personId == null ? null : Number(body.personId)
      if (personId !== null && !getPerson(db, personId)) throw new Error('Unknown person')
      const id = insertTag(db, scene.id, parseBox(body), personId)
      return c.json(serializeTag(db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  // Bulk insert for auto-detected faces. They start out unidentified.
  admin.post('/scenes/:id/tags/batch', async (c) => {
    const scene = getScene(db, Number(c.req.param('id')))
    if (!scene) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (!Array.isArray(body.boxes) || body.boxes.length > 2000) return c.json({ error: 'Invalid boxes' }, 400)
    try {
      const boxes = body.boxes.map(parseBox)
      db.exec('BEGIN')
      for (const box of boxes) insertTag(db, scene.id, box, null)
      db.exec('COMMIT')
      return c.json({ added: boxes.length }, 201)
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK')
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  // Clears the faces nobody has named yet, e.g. before re-running detection.
  admin.delete('/scenes/:id/unidentified-tags', (c) => {
    const result = db.prepare('DELETE FROM tags WHERE scene_id = ? AND person_id IS NULL').run(Number(c.req.param('id')))
    return c.json({ removed: Number(result.changes) })
  })

  admin.patch('/tags/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow | undefined
    if (!tag) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    try {
      const box = 'x' in body ? parseBox(body) : tag
      const personId = 'personId' in body ? (body.personId == null ? null : Number(body.personId)) : tag.person_id
      if (personId !== null && !getPerson(db, personId)) throw new Error('Unknown person')
      const text = (key: 'caption' | 'classLabel', current: string | null) =>
        key in body ? (typeof body[key] === 'string' && body[key].trim() ? body[key].trim().slice(0, 80) : null) : current
      const staff = 'staff' in body ? (body.staff ? 1 : 0) : tag.is_staff
      db.prepare('UPDATE tags SET person_id = ?, x = ?, y = ?, w = ?, h = ?, caption = ?, class_label = ?, is_staff = ? WHERE id = ?').run(
        staff ? null : personId, box.x, box.y, box.w, box.h, text('caption', tag.caption), text('classLabel', tag.class_label), staff, id,
      )
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json(serializeTag(db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow))
  })

  // Gives a face a profile of its own, named after its printed caption unless a name is given.
  // Also how a face that was matched to the wrong person is split off.
  admin.post('/tags/:id/new-person', async (c) => {
    const id = Number(c.req.param('id'))
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow | undefined
    if (!tag) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    try {
      const fields = parsePersonInput({ name: body.name ?? tag.caption, gender: body.gender ?? null }, { admin: true })
      if (!fields.name) throw new Error('חובה למלא שם')
      const personId = insertPerson(db, fields)
      db.prepare('UPDATE tags SET person_id = ?, is_staff = 0 WHERE id = ?').run(personId, id)
      return c.json(serializePerson(getPerson(db, personId)!, 'full'), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  admin.delete('/tags/:id', (c) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  admin.post('/rebuild-wall', async (c) => {
    await rebuildWall(db, config.dataDir)
    return c.json(listScenes(db))
  })

  // ---- Mixtape shelf ----
  admin.delete('/tapes/:id', (c) => {
    const result = db.prepare('DELETE FROM tapes WHERE id = ?').run(Number(c.req.param('id')))
    return result.changes ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  // ---- Video library ----
  admin.delete('/videos/:id', (c) => {
    const result = db.prepare('DELETE FROM videos WHERE id = ?').run(Number(c.req.param('id')))
    return result.changes ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  // ---- Quotes wall. Removing a quote removes its comments too. ----
  admin.delete('/quotes/:id', (c) => {
    const result = db.prepare('DELETE FROM quotes WHERE id = ?').run(Number(c.req.param('id')))
    return result.changes ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  admin.delete('/quote-comments/:id', (c) => {
    const result = db.prepare('DELETE FROM quote_comments WHERE id = ?').run(Number(c.req.param('id')))
    return result.changes ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  // ---- Overview: counts only. Notes are private, so only how many, never what or from whom. ----
  admin.get('/stats', (c) => {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    return c.json({
      people: count('SELECT COUNT(*) AS n FROM people'),
      claimed: count('SELECT COUNT(*) AS n FROM people WHERE claimed_at IS NOT NULL'),
      withPin: count('SELECT COUNT(*) AS n FROM people WHERE pin_hash IS NOT NULL'),
      withNowPhoto: count('SELECT COUNT(*) AS n FROM people WHERE now_photo IS NOT NULL'),
      inMemoriam: count('SELECT COUNT(*) AS n FROM people WHERE in_memoriam = 1'),
      attending: {
        yes: count("SELECT COUNT(*) AS n FROM people WHERE attending = 'yes'"),
        maybe: count("SELECT COUNT(*) AS n FROM people WHERE attending = 'maybe'"),
        no: count("SELECT COUNT(*) AS n FROM people WHERE attending = 'no'"),
      },
      faces: count("SELECT COUNT(*) AS n FROM tags JOIN scenes ON scenes.id = tags.scene_id WHERE scenes.kind = 'group' AND tags.is_staff = 0"),
      facesNamed: count("SELECT COUNT(*) AS n FROM tags JOIN scenes ON scenes.id = tags.scene_id WHERE scenes.kind = 'group' AND tags.is_staff = 0 AND tags.person_id IS NOT NULL"),
      notes: count('SELECT COUNT(*) AS n FROM notes'),
      notesUnread: count('SELECT COUNT(*) AS n FROM notes WHERE read_at IS NULL'),
      feedback: count('SELECT COUNT(*) AS n FROM feedback'),
      videos: count('SELECT COUNT(*) AS n FROM videos'),
      tapes: count('SELECT COUNT(*) AS n FROM tapes'),
      quotes: count('SELECT COUNT(*) AS n FROM quotes'),
      quoteComments: count('SELECT COUNT(*) AS n FROM quote_comments'),
      visits: getCounter(db, 'visits'),
    })
  })

  // ---- Backup: every profile, picture and face tag as one JSON download. Photos are not included,
  // and neither are sign-in secrets or private notes. ----
  admin.get('/export', (c) => {
    const people = (db.prepare('SELECT * FROM people ORDER BY id').all() as Record<string, unknown>[]).map(
      ({ edit_token_hash, pin_hash, ...person }) => person,
    )
    const exportedAt = new Date().toISOString()
    c.header('Content-Disposition', `attachment; filename="reunion-backup-${exportedAt.slice(0, 10)}.json"`)
    return c.json({
      exportedAt,
      schemaVersion: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      people,
      scenes: db.prepare('SELECT * FROM scenes ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    })
  })

  // ---- Roster: the names, classes and genders on the class photos, to carry between copies of the site ----
  admin.get('/roster/export', (c) => {
    c.header('Content-Disposition', `attachment; filename="reunion-roster-${new Date().toISOString().slice(0, 10)}.json"`)
    return c.json(exportRoster(db))
  })

  admin.post('/roster/import', async (c) => {
    try {
      return c.json(importRoster(db, parseRoster(await c.req.json().catch(() => null))))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  // ---- Feedback ----
  admin.get('/feedback', (c) => c.json(listFeedback(db)))

  admin.delete('/feedback/:id', (c) => {
    const result = db.prepare('DELETE FROM feedback WHERE id = ?').run(Number(c.req.param('id')))
    return result.changes ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  // ---- Demo data: only into an empty site ----
  admin.post('/demo', async (c) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }
    if (n > 0) return c.json({ error: 'Demo data can only be loaded into an empty site' }, 409)
    await loadDemoData(db, config.dataDir)
    return c.json({ ok: true })
  })

  return admin
}
