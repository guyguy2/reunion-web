import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Config } from './config.ts'
import { bumpCounter, getCounter, openDb, type Db, type PersonRow, type TagRow } from './db.ts'
import {
  clientKey,
  createLoginLimiter,
  endSession,
  newEditToken,
  readRole,
  requireSession,
  roleForPasscode,
  sha256,
  startSession,
  type AppEnv,
} from './auth.ts'
import { MAX_UPLOAD_BYTES, cropFace, readImageField, removeUpload, saveUpload } from './images.ts'
import { getPerson, insertPerson, listPeople, parsePersonInput, serializePerson, updatePerson } from './people.ts'
import { getScene, listScenes, serializeTag } from './scenes.ts'
import { adminRoutes } from './admin.ts'
import { albumPhotos } from './album.ts'
import { addTape, listTapes } from './tapes.ts'
import { addVideo, listVideos } from './videos.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.dzi': 'application/xml',
  '.woff2': 'font/woff2',
}

/** Sends a file from inside root, refusing anything that resolves outside it. */
function sendFile(c: Context, root: string, relPath: string, cacheControl: string) {
  const full = path.resolve(root, relPath)
  if (full !== root && !full.startsWith(root + path.sep)) return c.notFound()
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return c.notFound()
  return c.body(fs.readFileSync(full), 200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': cacheControl,
  })
}

function loadEvent() {
  const event = JSON.parse(fs.readFileSync(path.resolve('content/event.json'), 'utf8'))
  // Links that grant access stay out of git and come from the environment.
  event.memories = { ...event.memories, albumUrl: process.env.GOOGLE_PHOTOS_ALBUM_URL ?? '' }
  if (process.env.YOUTUBE_PLAYLIST_ID) event.music.youtubePlaylistId = process.env.YOUTUBE_PLAYLIST_ID
  return event
}

export function createApp(config: Config, db: Db = openDb(config.dataDir)) {
  const app = new Hono<AppEnv>()
  const limiter = createLoginLimiter()

  app.use('*', async (c, next) => {
    await next()
    c.header('X-Robots-Tag', 'noindex, nofollow')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'same-origin')
  })

  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path} failed:`, err.message)
    return c.json({ error: 'משהו השתבש' }, 500)
  })

  app.get('/healthz', (c) => c.json({ ok: true }))

  // ---- Public: session only ----
  app.get('/api/session', async (c) => c.json({ role: await readRole(c, config) }))

  app.post('/api/login', async (c) => {
    const key = clientKey(c)
    if (limiter.blocked(key)) return c.json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }, 429)
    const body = await c.req.json().catch(() => ({}))
    const role = typeof body.passcode === 'string' ? roleForPasscode(config, body.passcode) : null
    if (!role) {
      limiter.fail(key)
      return c.json({ error: 'סיסמה שגויה' }, 401)
    }
    limiter.clear(key)
    await startSession(c, config, role)
    bumpCounter(db, 'visits')
    return c.json({ role })
  })

  app.post('/api/logout', (c) => {
    endSession(c)
    return c.json({ ok: true })
  })

  // ---- Everything below needs the class passcode ----
  app.use('/api/*', requireSession(config))
  app.use('/media/*', requireSession(config))

  app.get('/media/*', (c) => {
    // Split on the raw path, then let sendFile confine the decoded remainder to that one folder.
    const [folder, ...rest] = c.req.path.slice('/media/'.length).split('/')
    if (folder !== 'scenes' && folder !== 'uploads') return c.notFound()
    let rel: string
    try {
      rel = decodeURIComponent(rest.join('/'))
    } catch {
      return c.notFound()
    }
    return sendFile(c, path.join(config.dataDir, folder), rel, 'private, max-age=31536000, immutable')
  })

  app.get('/api/event', (c) => c.json({ ...loadEvent(), visits: getCounter(db, 'visits') }))

  app.get('/api/memories/photos', async (c) => c.json(await albumPhotos(process.env.GOOGLE_PHOTOS_ALBUM_URL ?? '')))

  app.get('/api/scenes', (c) => c.json(listScenes(db)))

  // The mixtape shelf: any classmate can add a tape; organizers remove them in the admin routes.
  app.get('/api/tapes', (c) => c.json(listTapes(db)))

  app.post('/api/tapes', async (c) => {
    try {
      return c.json(await addTape(db, await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  // The video library works the same way: classmates add links, organizers remove them.
  app.get('/api/videos', (c) => c.json(listVideos(db, loadEvent().videos ?? [])))

  app.post('/api/videos', async (c) => {
    try {
      return c.json(await addVideo(db, await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.get('/api/people', (c) => {
    const view = c.get('role') === 'admin' ? 'full' : 'public'
    return c.json(listPeople(db).map((p) => serializePerson(p, view)))
  })

  // Someone who is not on the roster adds themselves; they own the new profile right away.
  app.post('/api/people', async (c) => {
    let fields
    try {
      fields = parsePersonInput(await c.req.json().catch(() => null), { admin: false })
      if (!fields.name) throw new Error('חובה למלא שם')
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    const token = newEditToken()
    const id = insertPerson(db, { ...fields, claimed_at: new Date().toISOString(), edit_token_hash: sha256(token) })
    return c.json({ token, person: serializePerson(getPerson(db, id)!, 'full') }, 201)
  })

  app.post('/api/people/:id/claim', (c) => {
    const token = newEditToken()
    // Single conditional UPDATE so two people cannot claim the same profile.
    const result = db
      .prepare(
        `UPDATE people SET claimed_at = ?, edit_token_hash = ?
         WHERE id = ? AND claimed_at IS NULL AND in_memoriam = 0`,
      )
      .run(new Date().toISOString(), sha256(token), Number(c.req.param('id')))
    if (result.changes === 0) {
      return c.json({ error: 'הפרופיל הזה כבר בבעלות מישהו. אם זה לא אתם, בקשו מהמארגנים לאפס אותו.' }, 409)
    }
    return c.json({ token })
  })

  // ---- Owner routes: authenticated by the private edit token ----
  const owner = (c: Context): PersonRow | undefined => {
    const token = c.req.header('x-edit-token')
    if (!token) return undefined
    return db.prepare('SELECT * FROM people WHERE edit_token_hash = ?').get(sha256(token)) as PersonRow | undefined
  }

  app.get('/api/me', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    return c.json(serializePerson(me, 'full'))
  })

  app.patch('/api/me', async (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    try {
      updatePerson(db, me.id, parsePersonInput(await c.req.json().catch(() => null), { admin: false }))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  app.post('/api/me/photo/:kind', async (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    const kind = c.req.param('kind')
    if (kind !== 'then' && kind !== 'now') return c.json({ error: 'Unknown photo kind' }, 400)
    let rel: string
    try {
      rel = await saveUpload(config.dataDir, await readImageField(c, 'photo', MAX_UPLOAD_BYTES))
    } catch (err) {
      return c.json({ error: (err as Error).message || 'לא הצלחנו לקרוא את התמונה' }, 400)
    }
    const column = kind === 'then' ? 'then_photo' : 'now_photo'
    removeUpload(config.dataDir, me[column])
    updatePerson(db, me.id, { [column]: rel })
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  // "Remove my info": wipes everything except the name, and releases the claim.
  app.delete('/api/me', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    removeUpload(config.dataDir, me.now_photo)
    updatePerson(db, me.id, {
      nickname: null, email: null, instagram: null, linkedin: null, facebook: null, website: null, phone: null, x: null, city: null, bio: null, quote: null,
      now_photo: null, attending: null, claimed_at: null, edit_token_hash: null,
    })
    return c.json({ ok: true })
  })

  // "That's me" on an unidentified face. Only the profile owner can attach themselves.
  app.post('/api/tags/:id/identify', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קודם צריך ליצור פרופיל' }, 403)
    const result = db
      .prepare('UPDATE tags SET person_id = ? WHERE id = ? AND person_id IS NULL')
      .run(me.id, Number(c.req.param('id')))
    if (result.changes === 0) return c.json({ error: 'כבר יש שם לתמונה הזו' }, 409)
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(c.req.param('id'))) as unknown as TagRow
    return c.json(serializeTag(tag))
  })

  // "I know who this is": any classmate can name an unidentified face, either as an existing
  // person or as a new, unclaimed profile. Organizers can correct mistakes from the admin page.
  app.post('/api/tags/:id/suggest', async (c) => {
    const tagId = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    let personId: number
    if (body.personId != null) {
      if (!getPerson(db, Number(body.personId))) return c.json({ error: 'Unknown person' }, 400)
      personId = Number(body.personId)
    } else {
      const open = db.prepare('SELECT id FROM tags WHERE id = ? AND person_id IS NULL').get(tagId)
      if (!open) return c.json({ error: 'כבר יש שם לתמונה הזו' }, 409)
      try {
        const fields = parsePersonInput({ name: body.name }, { admin: false })
        if (!fields.name) throw new Error('חובה למלא שם')
        personId = insertPerson(db, fields)
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400)
      }
    }
    const result = db.prepare('UPDATE tags SET person_id = ? WHERE id = ? AND person_id IS NULL').run(personId, tagId)
    if (result.changes === 0) return c.json({ error: 'כבר יש שם לתמונה הזו' }, 409)
    return c.json({ personId })
  })

  // Face crop for profile strips. The box is part of the cache key, so moved tags get fresh crops.
  app.get('/api/tags/:id/face', async (c) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(c.req.param('id'))) as unknown as TagRow | undefined
    const scene = tag && getScene(db, tag.scene_id)
    if (!tag || !scene) return c.notFound()
    const name = `${tag.id}-${[tag.x, tag.y, tag.w, tag.h].map(Math.round).join('-')}.webp`
    const file = path.join(config.dataDir, 'crops', name)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, await cropFace(config.dataDir, scene.tiles_path, tag))
    }
    return sendFile(c, path.join(config.dataDir, 'crops'), name, 'private, max-age=31536000, immutable')
  })

  app.route('/api/admin', adminRoutes(config, db))

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  // ---- Built frontend (single-page app) ----
  app.get('*', (c) => {
    const rel = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1))
    const isAsset = rel.startsWith('assets/')
    const file = fs.existsSync(path.join(config.webDir, rel)) && path.extname(rel) ? rel : 'index.html'
    return sendFile(c, config.webDir, file, isAsset ? 'public, max-age=31536000, immutable' : 'no-cache')
  })

  return app
}
