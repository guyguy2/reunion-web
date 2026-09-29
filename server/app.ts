import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Config } from './config.ts'
import { bumpCounter, getCounter, openDb, type Db, type PersonRow, type TagRow } from './db.ts'
import {
  clientKey,
  createLockout,
  createLoginLimiter,
  createThrottle,
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
import { MAX_SCENE_BYTES, MAX_UPLOAD_BYTES, cropFace, readImageField, removeUpload } from './images.ts'
import { addPhoto, deletePhoto, getPerson, insertPerson, listPeople, listPhotos, parsePersonInput, serializePerson, updatePerson } from './people.ts'
import { getScene, listScenes, serializeTag } from './scenes.ts'
import { adminRoutes } from './admin.ts'
import { albumPhotos, albumVideos } from './album.ts'
import { addTape, listTapes } from './tapes.ts'
import { addVideo, albumVideoEntries, listVideos } from './videos.ts'
import { addQuote, addQuoteComment, listQuotes, reactToQuote } from './quotes.ts'
import { listCredits } from './credits.ts'
import { addFeedback, feedbackSenderFor, type SendEmail } from './feedback.ts'
import { configuredMailer, type Mailer } from './email.ts'
import { redeemSignInLink, sendSignInLink } from './recovery.ts'
import { deleteNote, emailNoteAlert, listNotes, markNoteRead, sendNote, unreadNotes } from './notes.ts'

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

/** The JSON body when it is an object, else {} (bad JSON, null, a number, an array), so handlers can read its fields safely. */
async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null)
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

const HEBREW = /[\u0590-\u05FF]/

/** A 400 for an error thrown while handling a request. Our own messages are in Hebrew, written for the people using the
 * site, and go out as they are. Anything else (a library's, the database's) is logged and answered with `fallback`. */
function badRequest(c: Context, err: unknown, fallback = 'הבקשה לא תקינה') {
  const message = err instanceof Error ? err.message : String(err)
  if (HEBREW.test(message)) return c.json({ error: message }, 400)
  console.error(`${c.req.method} ${c.req.path} refused: ${message}`)
  return c.json({ error: fallback }, 400)
}

const MB = 1024 * 1024
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const limitBody = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: 'הקובץ או הבקשה גדולים מדי' }, 413) })
const smallBody = limitBody(64 * 1024)
// Uploads and organizer imports get room for their file. Every other API request is a small JSON body.
const largeBodies: [RegExp, MiddlewareHandler][] = [
  [/^\/api\/me\/photo\/[^/]+$/, limitBody(MAX_UPLOAD_BYTES + MB)],
  [/^\/api\/admin\/people\/[^/]+\/photo\/[^/]+$/, limitBody(MAX_UPLOAD_BYTES + MB)],
  [/^\/api\/admin\/scenes$/, limitBody(MAX_SCENE_BYTES + MB)],
  [/^\/api\/admin\/import-csv$/, limitBody(2 * MB)],
  [/^\/api\/admin\/scenes\/[^/]+\/tags\/batch$/, limitBody(2 * MB)],
  [/^\/api\/admin\/roster\/import$/, limitBody(2 * MB)],
]
const largeBodyLimit = (c: Context) => largeBodies.find(([route]) => route.test(c.req.path))?.[1]

function loadEvent() {
  // The real event details stay out of git in EVENT_JSON; content/event.json is only a placeholder.
  const event = JSON.parse(process.env.EVENT_JSON || fs.readFileSync(path.resolve('content/event.json'), 'utf8'))
  // Links that grant access stay out of git and come from the environment.
  event.memories = { ...event.memories, albumUrl: process.env.GOOGLE_PHOTOS_ALBUM_URL ?? '' }
  if (process.env.YOUTUBE_PLAYLIST_ID) event.music.youtubePlaylistId = process.env.YOUTUBE_PLAYLIST_ID
  return event
}

export function createApp(config: Config, db: Db = openDb(config.dataDir), mailer: Mailer | null = configuredMailer(config)) {
  const app = new Hono<AppEnv>()
  const limiter = createLoginLimiter()
  const pinLockout = createLockout()
  // Feedback and sign-in links send email, so each is limited per address and for everyone together. The per-address
  // limits leave room for a group sharing one address, such as guests on the venue wifi.
  const feedbackPerClient = createThrottle({ max: 10, windowMs: 10 * MINUTE })
  const feedbackPerDay = createThrottle({ max: 50, windowMs: DAY })
  const linksPerClient = createThrottle({ max: 10, windowMs: 10 * MINUTE })
  const linksPerPerson = createThrottle({ max: 5, windowMs: DAY, globalMax: 100 })

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

  // Small bodies only, before anything reads them. The larger upload limits apply once the session is checked.
  app.use('/api/*', (c, next) => (largeBodyLimit(c) ? next() : smallBody(c, next)))

  // ---- Public: session only ----
  app.get('/api/session', async (c) => c.json({ role: await readRole(c, config) }))

  // Wrong passcodes are counted per address, once for the class passcode and once for the admin one. A wrong guess
  // could be aimed at either, so it counts against both, and only an admin login resets the admin count:
  // logging in with the class passcode in between does not buy more admin guesses.
  app.post('/api/login', async (c) => {
    const ip = clientKey(c)
    const classKey = `login:${ip}`
    const adminKey = `admin:${ip}`
    if (limiter.blocked(classKey)) return c.json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }, 429)
    const body = await readJson(c)
    const role = typeof body.passcode === 'string' ? roleForPasscode(config, body.passcode) : null
    const adminBlocked = limiter.blocked(adminKey)
    // While admin guesses are blocked, the admin passcode gets the same ordinary answer as a wrong one, so it cannot be
    // confirmed, and a guest whose typos filled the admin count is not told to wait.
    if (!role || (role === 'admin' && adminBlocked)) {
      limiter.fail(classKey)
      if (!adminBlocked) limiter.fail(adminKey)
      return c.json({ error: 'סיסמה שגויה' }, 401)
    }
    limiter.clear(classKey)
    if (role === 'admin') limiter.clear(adminKey)
    await startSession(c, config, role)
    bumpCounter(db, 'visits')
    return c.json({ role })
  })

  app.post('/api/logout', (c) => {
    // Also retires the device key it was sent with, so a copy left on the device stops working. Only device keys:
    // the owner's edit token from claiming the profile is not one, and stays valid.
    const token = c.req.header('x-edit-token')
    if (token) db.prepare('DELETE FROM device_tokens WHERE token_hash = ?').run(sha256(token))
    endSession(c)
    return c.json({ ok: true })
  })

  // ---- Everything below needs the class passcode ----
  app.use('/api/*', requireSession(config))
  app.use('/media/*', requireSession(config))
  app.use('/api/*', (c, next) => {
    const limit = largeBodyLimit(c)
    if (!limit) return next()
    // The organizer paths get their larger limit only for organizers, so a classmate cannot make the server hold a big body.
    return c.req.path.startsWith('/api/admin/') && c.get('role') !== 'admin' ? smallBody(c, next) : limit(c, next)
  })

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

  // The credits live in the database, not in EVENT_JSON, so the organizers can edit them from the site.
  app.get('/api/event', (c) => c.json({ ...loadEvent(), credits: listCredits(db), visits: getCounter(db, 'visits') }))

  app.get('/api/memories/photos', async (c) => c.json(await albumPhotos(process.env.GOOGLE_PHOTOS_ALBUM_URL ?? '')))

  app.get('/api/scenes', (c) => c.json(listScenes(db)))

  // The mixtape shelf: any classmate can add a tape; organizers remove them in the admin routes.
  app.get('/api/tapes', (c) => c.json(listTapes(db)))

  app.post('/api/tapes', async (c) => {
    try {
      return c.json(await addTape(db, await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return badRequest(c, err)
    }
  })

  // The video library works the same way: classmates add links, organizers remove them.
  // Videos in the shared Google Photos album show up here too, after the pasted links.
  app.get('/api/videos', async (c) => {
    const albumUrl = process.env.GOOGLE_PHOTOS_ALBUM_URL ?? ''
    const event = loadEvent()
    return c.json([...listVideos(db, event.videos ?? []), ...albumVideoEntries(await albumVideos(albumUrl), albumUrl, event.memories.videoTitles)])
  })

  app.post('/api/videos', async (c) => {
    try {
      return c.json(await addVideo(db, await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return badRequest(c, err)
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
      return badRequest(c, err)
    }
  })

  app.post('/api/quotes', async (c) => {
    try {
      return c.json(addQuote(db, await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return badRequest(c, err)
    }
  })

  app.post('/api/quotes/:id/comments', async (c) => {
    try {
      return c.json(addQuoteComment(db, Number(c.req.param('id')), await c.req.json().catch(() => null)), 201)
    } catch (err) {
      return badRequest(c, err)
    }
  })

  // Feedback to the organizers: saved, then emailed when email is configured and the day's emails are not used up.
  const sendFeedback = feedbackSenderFor(mailer, config.feedbackTo)
  // Counts toward the day's emails only when one is actually tried. addFeedback calls it without awaiting anything
  // first, so no other request can come between the check in the route and this hit.
  const countedFeedback: SendEmail | null =
    sendFeedback &&
    ((message) => {
      feedbackPerDay.hit('all')
      return sendFeedback(message)
    })
  app.post('/api/feedback', async (c) => {
    if (!feedbackPerClient.allow(clientKey(c))) return c.json({ error: 'יותר מדי בקשות. נסו שוב מאוחר יותר.' }, 429)
    try {
      const body = await c.req.json().catch(() => null)
      // Past the day's emails, feedback is still saved for the organizers' inbox, just not emailed.
      return c.json(await addFeedback(db, body, feedbackPerDay.check('all') ? countedFeedback : null), 201)
    } catch (err) {
      return badRequest(c, err)
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
      return badRequest(c, err)
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
      return badRequest(c, err)
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
    // Once a profile is blocked, each further wrong guess blocks it for twice as long (createLockout).
    const deviceKey = `pin:${clientKey(c)}`
    const profileKey = `pin:${person?.id}`
    if (limiter.blocked(deviceKey) || pinLockout.blocked(profileKey)) return c.json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' }, 429)
    const body = await readJson(c)
    if (!person?.pin_hash) return c.json({ error: 'לפרופיל הזה עדיין אין קוד. פתחו את קישור העריכה או בקשו מהמארגנים לאפס אותו.' }, 400)
    if (typeof body.pin !== 'string' || !verifyPin(body.pin, person.pin_hash)) {
      limiter.fail(deviceKey)
      pinLockout.fail(profileKey)
      return c.json({ error: 'הקוד לא נכון' }, 401)
    }
    limiter.clear(deviceKey)
    pinLockout.clear(profileKey)
    const token = newEditToken()
    db.prepare('INSERT INTO device_tokens (token_hash, person_id) VALUES (?, ?)').run(sha256(token), person.id)
    return c.json({ token })
  })

  // Forgot the code (or never set one): a one-time sign-in link to the email on the profile.
  app.post('/api/people/:id/signin-link', async (c) => {
    const id = Number(c.req.param('id'))
    const ip = clientKey(c)
    // Every limit is checked before the profile is looked at, so a refusal says nothing about it, and before any is
    // counted, so a refused request uses nothing up.
    if (!linksPerClient.check(ip) || !linksPerPerson.check(String(id))) return c.json({ error: 'יותר מדי בקשות. נסו שוב מאוחר יותר.' }, 429)
    linksPerClient.hit(ip)
    const person = getPerson(db, id)
    if (!person?.claimed_at) return c.json({ error: 'Not found' }, 404)
    if (!config.publicUrl) {
      console.error(`Sign-in link for person ${person.id} not sent: PUBLIC_URL is not set, so the link would have no address`)
      return c.json({ error: 'משהו השתבש' }, 500)
    }
    // The profile's count and everyone's go up only when an email is actually tried. sendSignInLink calls the mailer
    // without awaiting anything first, so no other request can come between the check above and this hit.
    const counted: Mailer | null =
      mailer &&
      ((message) => {
        linksPerPerson.hit(String(id))
        return mailer(message)
      })
    try {
      const sentTo = await sendSignInLink(db, person, counted, config.publicUrl)
      return c.json({ sentTo })
    } catch (err) {
      return badRequest(c, err)
    }
  })

  app.post('/api/signin', async (c) => {
    const body = await readJson(c)
    const result = typeof body.token === 'string' ? redeemSignInLink(db, body.token) : null
    if (!result) return c.json({ error: 'הקישור כבר לא בתוקף. בקשו קישור חדש.' }, 400)
    // Whoever used a link can read that inbox, so their address gets its link requests back, as a right passcode does.
    linksPerClient.clear(clientKey(c))
    return c.json({ token: result.deviceToken })
  })

  // ---- Owner routes: authenticated by the private edit token, or a device key from signing in with the code ----
  const owner = (c: Context): PersonRow | undefined => {
    const token = c.req.header('x-edit-token')
    if (!token) return undefined
    const row = db
      .prepare(
        `SELECT * FROM people WHERE edit_token_hash = ?1
         OR id = (SELECT person_id FROM device_tokens WHERE token_hash = ?1)`,
      )
      .get(sha256(token)) as PersonRow | undefined
    // Attached here too, so a row from this lookup serializes the same as one from getPerson.
    if (row) row.photos = listPhotos(db, row.id)
    return row
  }

  app.put('/api/me/pin', async (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    const body = await readJson(c)
    try {
      updatePerson(db, me.id, { pin_hash: hashPin(typeof body.pin === 'string' ? body.pin : '') })
    } catch (err) {
      return badRequest(c, err)
    }
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  app.get('/api/me', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    return c.json({ ...serializePerson(me, 'full'), unreadNotes: unreadNotes(db, me.id) })
  })

  // Notes: passed privately to one classmate, who gets an email that one is waiting.
  // Only the recipient can read or throw them away.
  app.post('/api/notes', async (c) => {
    let recipient
    try {
      recipient = sendNote(db, await c.req.json().catch(() => null), owner(c))
    } catch (err) {
      return badRequest(c, err)
    }
    if (!config.publicUrl) {
      console.error(`Note alert for person ${recipient.id} skipped: PUBLIC_URL is not set, so its links would have no address`)
      return c.json({ ok: true }, 201)
    }
    // Not awaited: the note is already delivered, and the Gmail relay can take half a minute.
    const event = loadEvent()
    emailNoteAlert(db, recipient, mailer, config.publicUrl, event.emailSignature || event.title).catch((err) =>
      console.error(`Note alert for person ${recipient.id} failed: ${(err as Error).message}`),
    )
    return c.json({ ok: true }, 201)
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
      return badRequest(c, err)
    }
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  app.post('/api/me/photo/:kind', async (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    const kind = c.req.param('kind')
    if (kind !== 'then' && kind !== 'now') return c.json({ error: 'סוג תמונה לא מוכר' }, 400)
    try {
      await addPhoto(db, config.dataDir, me.id, kind, await readImageField(c, 'photo', MAX_UPLOAD_BYTES))
    } catch (err) {
      return badRequest(c, err, 'הקובץ אינו תמונה תקינה')
    }
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  app.delete('/api/me/photo/:id', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    if (!deletePhoto(db, config.dataDir, me.id, Number(c.req.param('id')))) return c.json({ error: 'Not found' }, 404)
    return c.json(serializePerson(getPerson(db, me.id)!, 'full'))
  })

  // "Remove my info": wipes everything except the name and the "then" photos (the former name and notes included),
  // and releases the claim. All in one transaction, so a failure part way changes nothing.
  app.delete('/api/me', (c) => {
    const me = owner(c)
    if (!me) return c.json({ error: 'קישור העריכה אינו תקף' }, 403)
    let files: string[] = []
    db.exec('BEGIN')
    try {
      updatePerson(db, me.id, {
        former_name: null, nickname: null, email: null, instagram: null, linkedin: null, facebook: null, website: null, phone: null, x: null, city: null, bio: null, quote: null,
        attending: null, claimed_at: null, edit_token_hash: null, pin_hash: null,
        // The mirror people.ts keeps for the portrait wall, of the "now" photos that go below.
        now_photo: null,
      })
      db.prepare('DELETE FROM notes WHERE recipient_id = ?').run(me.id)
      db.prepare('DELETE FROM device_tokens WHERE person_id = ?').run(me.id)
      db.prepare('DELETE FROM recovery_tokens WHERE person_id = ?').run(me.id)
      // The own "now" photos: the rows go here, the files only after the commit, since a rollback cannot bring files back.
      files = listPhotos(db, me.id, 'now').map((p) => p.path)
      db.prepare("DELETE FROM person_photos WHERE person_id = ? AND kind = 'now'").run(me.id)
      db.exec('COMMIT')
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw err
    }
    for (const rel of files) {
      try {
        removeUpload(config.dataDir, rel)
      } catch (err) {
        // Only logged: the removal is already saved.
        console.error(`Photo file ${rel} was not deleted: ${(err as Error).message}`)
      }
    }
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
    const body = await readJson(c)
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
        return badRequest(c, err)
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
    let rel: string
    try {
      rel = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1))
    } catch {
      return c.notFound()
    }
    const isAsset = rel.startsWith('assets/')
    const file = fs.existsSync(path.join(config.webDir, rel)) && path.extname(rel) ? rel : 'index.html'
    return sendFile(c, config.webDir, file, isAsset ? 'public, max-age=31536000, immutable' : 'no-cache')
  })

  return app
}
