import { Hono } from 'hono'
import type { Config } from './config.ts'
import { getCounter, type Db, type TagRow } from './db.ts'
import { requireAdmin, type AppEnv } from './auth.ts'
import { MAX_SCENE_BYTES, MAX_UPLOAD_BYTES, readImageField, removeUpload, saveUpload } from './images.ts'
import { getPerson, insertPerson, parseCsv, parsePersonInput, serializePerson, updatePerson } from './people.ts'
import { addGroupScene, deleteScene, getScene, insertTag, listScenes, rebuildWall, serializeTag } from './scenes.ts'
import { loadDemoData } from './demo.ts'
import { listFeedback } from './feedback.ts'

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
    removeUpload(config.dataDir, person.then_photo)
    removeUpload(config.dataDir, person.now_photo)
    db.prepare('DELETE FROM people WHERE id = ?').run(person.id)
    return c.json({ ok: true })
  })

  admin.post('/people/:id/reset-claim', (c) => {
    // Signs out every device too: the code and all device keys go with the claim.
    const id = Number(c.req.param('id'))
    db.prepare('UPDATE people SET claimed_at = NULL, edit_token_hash = NULL, pin_hash = NULL WHERE id = ?').run(id)
    db.prepare('DELETE FROM device_tokens WHERE person_id = ?').run(id)
    return c.json({ ok: true })
  })

  admin.post('/people/:id/photo/:kind', async (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    const kind = c.req.param('kind')
    if (!person) return c.json({ error: 'Not found' }, 404)
    if (kind !== 'then' && kind !== 'now') return c.json({ error: 'Unknown photo kind' }, 400)
    let rel: string
    try {
      rel = await saveUpload(config.dataDir, await readImageField(c, 'photo', MAX_UPLOAD_BYTES))
    } catch (err) {
      return c.json({ error: (err as Error).message || 'לא הצלחנו לקרוא את התמונה' }, 400)
    }
    const column = kind === 'then' ? 'then_photo' : 'now_photo'
    removeUpload(config.dataDir, person[column])
    updatePerson(db, person.id, { [column]: rel })
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
      db.prepare('UPDATE tags SET person_id = ?, x = ?, y = ?, w = ?, h = ? WHERE id = ?').run(
        personId, box.x, box.y, box.w, box.h, id,
      )
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json(serializeTag(db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow))
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
      faces: count("SELECT COUNT(*) AS n FROM tags JOIN scenes ON scenes.id = tags.scene_id WHERE scenes.kind = 'group'"),
      facesNamed: count("SELECT COUNT(*) AS n FROM tags JOIN scenes ON scenes.id = tags.scene_id WHERE scenes.kind = 'group' AND tags.person_id IS NOT NULL"),
      notes: count('SELECT COUNT(*) AS n FROM notes'),
      notesUnread: count('SELECT COUNT(*) AS n FROM notes WHERE read_at IS NULL'),
      feedback: count('SELECT COUNT(*) AS n FROM feedback'),
      videos: count('SELECT COUNT(*) AS n FROM videos'),
      tapes: count('SELECT COUNT(*) AS n FROM tapes'),
      visits: getCounter(db, 'visits'),
    })
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
