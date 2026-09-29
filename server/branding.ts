import fs from 'node:fs'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import sharp from 'sharp'
import type { Config } from './config.ts'
import { readImageField } from './images.ts'

/**
 * The site's own pictures: the emblem in the header, the postcard behind the passcode screen and the two icons. The
 * real ones would identify the school, so they stay out of git. An organizer uploads them into DATA_DIR/branding from
 * the admin page, and until then each name gets a neutral placeholder from web/public/branding, which the build copies
 * into the client (WEB_DIR/branding).
 */
const PICTURES = {
  'emblem.png': { format: 'png', type: 'image/png', maxSide: 512 },
  'postcard.webp': { format: 'webp', type: 'image/webp', maxSide: 2400 },
  'favicon.png': { format: 'png', type: 'image/png', maxSide: 256 },
  'apple-touch-icon.png': { format: 'png', type: 'image/png', maxSide: 512 },
} as const
type Name = keyof typeof PICTURES

export const MAX_BRANDING_BYTES = 5 * 1024 * 1024

const HEBREW = /[֐-׿]/

// Only these four names are ever read or written, so a name cannot lead anywhere outside the two folders.
const isName = (name: string | undefined): name is Name => name !== undefined && Object.hasOwn(PICTURES, name)

const uploadsDir = (config: Config) => path.join(config.dataDir, 'branding')

/** The organizers' upload if there is one, else the placeholder. Null when neither is there. */
function readPicture(config: Config, name: Name): Buffer | null {
  for (const dir of [uploadsDir(config), path.join(config.webDir, 'branding')]) {
    try {
      return fs.readFileSync(path.join(dir, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return null
}

/** GET /branding/:name. No session needed: the postcard and the favicon show on the passcode screen. */
export function brandingRoutes(config: Config): Hono {
  const app = new Hono()
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    if (!isName(name)) return c.notFound()
    const picture = readPicture(config, name)
    if (!picture) return c.notFound()
    return c.body(new Uint8Array(picture), 200, { 'Content-Type': PICTURES[name].type, 'Cache-Control': 'public, max-age=3600' })
  })
  app.all('*', (c) => c.notFound())
  return app
}

/** POST /api/admin/branding/:name, registered with the admin routes. Whatever image comes in is saved in the format its
 * name says, since the name sets the Content-Type and browsers are told not to guess. */
export async function uploadBranding(c: Context, config: Config) {
  const name = c.req.param('name')
  if (!isName(name)) return c.json({ error: 'Not found' }, 404)
  const { format, maxSide } = PICTURES[name]
  let image: Buffer
  try {
    const resized = sharp(await readImageField(c, 'file', MAX_BRANDING_BYTES))
      .rotate()
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    image = await (format === 'webp' ? resized.webp({ quality: 85 }) : resized.png()).toBuffer()
  } catch (err) {
    const message = (err as Error).message
    if (HEBREW.test(message)) return c.json({ error: message }, 400)
    console.error(`${c.req.method} ${c.req.path} refused: ${message}`)
    return c.json({ error: 'הקובץ אינו תמונה תקינה' }, 400)
  }
  const file = path.join(uploadsDir(config), name)
  fs.mkdirSync(uploadsDir(config), { recursive: true })
  // Written aside and renamed into place, so a visitor gets the old picture or the new one, never half of one.
  fs.writeFileSync(`${file}.tmp`, image)
  fs.renameSync(`${file}.tmp`, file)
  return c.json({ ok: true })
}

/** DELETE /api/admin/branding/:name: back to the placeholder. */
export function removeBranding(c: Context, config: Config) {
  const name = c.req.param('name')
  if (!isName(name)) return c.json({ error: 'Not found' }, 404)
  fs.rmSync(path.join(uploadsDir(config), name), { force: true })
  return c.json({ ok: true })
}
