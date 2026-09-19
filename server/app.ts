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
  hashPin,
  sha256,
  verifyPin,
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
import { addQuote, addQuoteComment, listQuotes, reactToQuote } from './quotes.ts'
import { addFeedback, resendSender } from './feedback.ts'
import { resendMailer, type Mailer } from './email.ts'
import { redeemSignInLink, sendSignInLink } from './recovery.ts'
import { deleteNote, listNotes, markNoteRead, sendNote, unreadNotes } from './notes.ts'

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
  // The real event details stay out of git in EVENT_JSON; content/event.json is only a placeholder.
  const event = JSON.parse(process.env.EVENT_JSON || fs.readFileSync(path.resolve('content/event.json'), 'utf8'))
  // Links that grant access stay out of git and come from the environment.
  event.memories = { ...event.memories, albumUrl: process.env.GOOGLE_PHOTOS_ALBUM_URL ?? '' }
  if (process.env.YOUTUBE_PLAYLIST_ID) event.music.youtubePlaylistId = process.env.YOUTUBE_PLAYLIST_ID
  return event
}

export function createApp(config: Config, db: Db = openDb(config.dataDir), mailer: Mailer | null = resendMailer(config)) {
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

  // The quotes wall: things teachers and classmates used to say. Anyone can add one or comment; organizers remove.
  // Reactions count once per person: the signed-in profile, else the random key the visitor's browser keeps.
  const reactorOf = (c: Context): string | null => {
    const me = owner(c)
    if (me) return `p${me.id}`
    const key = c.req.header('x-reactor') ?? ''
    return /^[A-Za-z0-9-]{16,64}$/.test(key) ? `b${key}` : null
  }

  app.get('/api/quotes', (c) => c.json(listQuotes(db, reactorOf(c))))

  app.put('/api/quotes/:id/reaction', async (c) => {
    try {
      return c.json(reactToQuote(db, Number(c.req.param('id')), reactorOf(c), await c.req.json().catch(() => null)))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.post('/api/quotes', async (c) => {
    try {
      return c.json(addQuote(db, await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.post('/api/quotes/:id/comments', async (c) => {
    try {
      return c.json(addQuoteComment(db, Number(c.req.param('id')), await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  // Feedback to the organizers: saved, then emailed when email is configured.
  const sendFeedback = resendSender(config)
  app.post('/api/feedback', async (c) => {
    try {
      return c.json(await addFeedback(db, await c.req.json().catch(() => null), sendFeedback), 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.get('/api/people', (c) => {
    const view = c.get('role') === 'admin' ? 'full' : 'public'
    return c.json(listPeople(db).map((p) => serializePerson(p, view)))
  })

  /** The personal code chosen while claiming or creating a profile. Optional here; the site's forms always ask for it. */
  const pinFrom = (body: unknown) => {
    const pin = (body as { pin?: unknown } | null)?.pin
    return typeof pin === 'string' && pin.trim() ? hashPin(pin) : null
  }

  // Someone who is not on the roster adds themselves; they own the new profile right away.
  app.post('/api/people', async (c) => {
    let fields
    let pinHash
    try {
      const body = await c.req.json().catch(() => null)
      fields = parsePersonInput(body, { admin: false })
      if (!fields.name) throw new Error('חובה למלא שם')
      pinHash = pinFrom(body)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    const token = newEditToken()
    const id = insertPerson(db, { ...fields, claimed_at: new Date().toISOString(), edit_token_hash: sha256(token), pin_hash: pinHash })
    return c.json({ token, person: serializePerson(getPerson(db, id)!, 'full') }, 201)
  })

  app.post('/api/people/:id/claim', async (c) => {
    let pinHash
    let email
    try {
      const body = await c.req.json().catch(() => null)
      pinHash = pinFrom(body)
      email = parsePersonInput({ email: (body as { email?: unknown } | null)?.email ?? null }, { admin: false }).email ?? null
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    const token = newEditToken()
    // Single conditional UPDATE so two people cannot claim the same profile.
    const result = db
      .prepare(
        `UPDATE people SET claimed_at = ?, edit_token_hash = ?, pin_hash = COALESCE(?, pin_hash), email = COALESCE(?, email)
         WHERE id = ? AND claimed_at IS NULL AND in_memoriam = 0`,
      )
      .run(new Date().toISOString(), sha256(token), pinHash, email, Number(c.req.param('id')))
    if (result.changes === 0) {
      return c.json({ error: 'הפרופיל הזה כבר בבעלות מישהו. אם זה לא אתם, בקשו מהמארגנים לאפס אותו.' }, 409)
    }
    return c.json({ token })
  })

  // Signing in on another phone or computer with the personal code. Each device gets its own key,
  // so signing in here never logs out the others. Wrong guesses are limited per device and per profile.
  app.post('/api/people/:id/login', async (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    const keys = [clientKey(c), `person:${person?.id}`]
    if (keys.some((k) => limiter.blocked(k))) return c.json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }, 429)
    const body = await c.req.json().catch(() => ({}))
    if (!person?.pin_hash) return c.json({ error: 'לפרופיל הזה עדיין אין קוד. פתחו את קישור העריכה או בקשו מהמארגנים לאפס אותו.' }, 400)
    if (typeof body.pin !== 'string' || !verifyPin(body.pin, person.pin_hash)) {
      keys.forEach((k) => limiter.fail(k))
      return c.json({ error: 'הקוד לא נכון' }, 401)
    }
    keys.forEach((k) => limiter.clear(k))
    const token = newEditToken()
    db.prepare('INSERT INTO device_tokens (token_hash, person_id) VALUES (?, ?)').run(sha256(token), person.id)
    return c.json({ token })
  })

  // Forgot the code (or never set one): a one-time sign-in link to the email on the profile.
  app.post('/api/people/:id/signin-link', async (c) => {
    const person = getPerson(db, Number(c.req.param('id')))
    if (!person?.claimed_at) return c.json({ error: 'Not found' }, 404)
    try {
      const sentTo = await sendSignInLink(db, person, mailer, config.publicUrl ?? new URL(c.req.url).origin)
      return c.json({ sentTo })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.post('/api/signin', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = typeof body.token === 'string' ? redeemSignInLink(db, body.token) : null
    if (!result) return c.json({ error: 'הקישור כבר לא בתוקף. בקשו קישור חדש.' }, 400)
    return c.json({ token: result.deviceToken })
  })

  // ---- Owner routes: authenticated by the private edit token, or a device key from signing in with the code ----
  const owner = (c: Context): PersonRow | undefined => {
    const token = c.req.header('x-edit-token')
    if (!token) return undefined
    return db
      .prepare(
        `SELECT * FROM people WHERE edit_token_hash = ?1
         OR id = (SELECT person_id FROM device_tokens WHERE token_hash = ?1)`,
      )
      .get(sha256(token)) as PersonRow | undefined
  }

  app.put('/api/me/pin', async (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    const body = await c.req.json().catch(() => ({}))
    try {
      updatePerson(db, me.id, { pin_hash: hashPin(typeof body.pin === 'string' ? body.pin : '') })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  app.get('/api/me', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    return c.json({ ...serializePerson(me, 'full'), unreadNotes: unreadNotes(db, me.id) })
  })

  // Notes: passed privately to one classmate. Only the recipient can read or throw them away.
  app.post('/api/notes', async (c) => {
    try {
      sendNote(db, await c.req.json().catch(() => null), owner(c))
      return c.json({ ok: true }, 201)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.get('/api/me/notes', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    return c.json(listNotes(db, me.id))
  })

  app.post('/api/me/notes/:id/read', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    return markNoteRead(db, me.id, Number(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
  })

  app.delete('/api/me/notes/:id', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    return deleteNote(db, me.id, Number(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
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

  // "Remove my info": wipes everything except the name (notes included), and releases the claim.
  app.delete('/api/me', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    removeUpload(config.dataDir, me.now_photo)
    updatePerson(db, me.id, {
      nickname: null, email: null, instagram: null, linkedin: null, facebook: null, website: null, phone: null, x: null, city: null, bio: null, quote: null,
      now_photo: null, attending: null, claimed_at: null, edit_token_hash: null, pin_hash: null,
    })
    db.prepare('DELETE FROM notes WHERE recipient_id = ?').run(me.id)
    db.prepare('DELETE FROM device_tokens WHERE person_id = ?').run(me.id)
    db.prepare('DELETE FROM recovery_tokens WHERE person_id = ?').run(me.id)
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

  // "That's not me": the owner puts a face tagged as them back to unnamed, whoever tagged it.
  // Class photos only; the generated wall always shows everyone.
  app.delete('/api/tags/:id/identify', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    const tagId = Number(c.req.param('id'))
    const result = db
      .prepare(
        `UPDATE tags SET person_id = NULL
         WHERE id = ? AND person_id = ? AND scene_id IN (SELECT id FROM scenes WHERE kind = 'group')`,
      )
      .run(tagId, me.id)
    if (result.changes === 0) return c.json({ error: 'התמונה הזו לא מתויגת בשם שלך' }, 404)
    return c.json(serializeTag(db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId) as unknown as TagRow))
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
    // "?caption" widens the crop to take in the name printed under the photo, for checking it in the roster tool.
    const wide = c.req.query('caption') != null
    const name = `${tag.id}-${[tag.x, tag.y, tag.w, tag.h].map(Math.round).join('-')}${wide ? '-c' : ''}.webp`
    const file = path.join(config.dataDir, 'crops', name)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const box = wide ? { x: tag.x - tag.w * 0.4, y: tag.y, w: tag.w * 1.8, h: tag.h * 1.5 } : tag
      fs.writeFileSync(file, await cropFace(config.dataDir, scene.tiles_path, box))
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
