import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp, { type OverlayOptions } from 'sharp'
import type { Context } from 'hono'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_SCENE_BYTES = 40 * 1024 * 1024

// Wall (mosaic) geometry, in pixels of the generated image.
export const WALL = { photoW: 320, photoH: 400, captionH: 48, gutter: 24, margin: 48 }

const PALETTE = ['#14b8a6', '#ec4899', '#8b5cf6', '#facc15', '#fb923c', '#38bdf8']

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts
  return letters.map((p) => p[0]?.toUpperCase() ?? '').join('')
}

/** Resize, auto-orient, strip metadata (sharp drops EXIF by default) and store as WebP. Returns the path relative to dataDir. */
export async function saveUpload(dataDir: string, input: Buffer): Promise<string> {
  const rel = path.join('uploads', `${crypto.randomBytes(12).toString('hex')}.webp`)
  const dest = path.join(dataDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  await sharp(input)
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(dest)
  return rel
}

export function removeUpload(dataDir: string, rel: string | null) {
  if (!rel || !rel.startsWith('uploads')) return
  fs.rmSync(path.join(dataDir, rel), { force: true })
}

/** Writes a Deep Zoom pyramid under dataDir/scenes/<dirName>/ and returns the image size plus the relative tiles path. */
export async function tileScene(dataDir: string, dirName: string, input: Buffer) {
  const rel = path.join('scenes', dirName)
  const dir = path.join(dataDir, rel)
  fs.mkdirSync(dir, { recursive: true })
  const { data, info } = await sharp(input, { limitInputPixels: 400_000_000 })
    .rotate()
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  await sharp(data, { limitInputPixels: 400_000_000 })
    .jpeg({ quality: 85 })
    .tile({ size: 256, overlap: 1, layout: 'dz' })
    .toFile(path.join(dir, 'scene.dz'))
  // Keep the full image too: face crops for profiles and the wall are cut from it.
  fs.writeFileSync(path.join(dir, 'scene.jpg'), data)
  return { width: info.width, height: info.height, tilesPath: rel }
}

/** Cuts one face (with some breathing room) out of a scene's full image. */
export async function cropFace(dataDir: string, tilesPath: string, box: Box, size = 400): Promise<Buffer> {
  const source = path.join(dataDir, tilesPath, 'scene.jpg')
  const meta = await sharp(source, { limitInputPixels: 400_000_000 }).metadata()
  const padX = box.w * 0.25
  const padY = box.h * 0.25
  const left = Math.max(0, Math.round(box.x - padX))
  const top = Math.max(0, Math.round(box.y - padY))
  const width = Math.min(meta.width - left, Math.round(box.w + padX * 2))
  const height = Math.min(meta.height - top, Math.round(box.h + padY * 2))
  if (width < 1 || height < 1) throw new Error('Box is outside the image')
  return sharp(source, { limitInputPixels: 400_000_000 })
    .extract({ left, top, width, height })
    .resize(size, size, { fit: 'inside' })
    .webp({ quality: 85 })
    .toBuffer()
}

export function removeSceneFiles(dataDir: string, tilesPath: string) {
  if (!tilesPath.startsWith('scenes')) return
  fs.rmSync(path.join(dataDir, tilesPath), { recursive: true, force: true })
}

/** Grid geometry for the portrait wall. Pure, so it can be tested without rendering. */
export function wallLayout(count: number) {
  const n = Math.max(count, 1)
  const cellW = WALL.photoW + WALL.gutter
  const cellH = WALL.photoH + WALL.captionH + WALL.gutter
  // Aim for a roughly 16:10 wall.
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * 1.6 * cellH) / cellW)))
  const rows = Math.ceil(n / cols)
  const width = WALL.margin * 2 + cols * cellW - WALL.gutter
  const height = WALL.margin * 2 + rows * cellH - WALL.gutter
  const boxes: Box[] = []
  for (let i = 0; i < count; i++) {
    boxes.push({
      x: WALL.margin + (i % cols) * cellW,
      y: WALL.margin + Math.floor(i / cols) * cellH,
      w: WALL.photoW,
      h: WALL.photoH,
    })
  }
  return { cols, rows, width, height, boxes }
}

function placeholderPortrait(name: string, index: number): Buffer {
  const color = PALETTE[index % PALETTE.length]
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WALL.photoW}" height="${WALL.photoH}">
      <rect width="100%" height="100%" fill="${color}"/>
      <circle cx="160" cy="165" r="70" fill="#fff" fill-opacity="0.35"/>
      <path d="M40 400 C40 290 280 290 280 400 Z" fill="#fff" fill-opacity="0.35"/>
      <text x="160" y="190" font-family="DejaVu Sans, Arial, sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#111">${escapeXml(initials(name))}</text>
    </svg>`,
  )
}

function caption(name: string): Buffer {
  const label = name.length > 22 ? `${name.slice(0, 21)}...` : name
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WALL.photoW}" height="${WALL.captionH}">
      <text x="${WALL.photoW / 2}" y="32" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="700" text-anchor="middle" fill="#111">${escapeXml(label)}</text>
    </svg>`,
  )
}

export interface WallPerson {
  id: number
  name: string
  then_photo: string | null
  /** Used when there is no uploaded then-photo, e.g. a face cropped from a class poster. */
  fallback?: Buffer | null
}

/** Composes every person's "then" portrait into one yearbook-style wall image. Boxes line up with the input order. */
export async function buildWall(dataDir: string, people: WallPerson[]) {
  const layout = wallLayout(people.length)
  const layers: OverlayOptions[] = []
  for (const [i, person] of people.entries()) {
    const box = layout.boxes[i]
    let portrait: Buffer | null = null
    if (person.then_photo) {
      try {
        portrait = await sharp(path.join(dataDir, person.then_photo))
          .resize(WALL.photoW, WALL.photoH, { fit: 'cover', position: 'attention' })
          .toBuffer()
      } catch {
        portrait = null
      }
    }
    if (!portrait && person.fallback) {
      portrait = await sharp(person.fallback)
        .resize(WALL.photoW, WALL.photoH, { fit: 'cover' })
        .toBuffer()
        .catch(() => null)
    }
    portrait ??= await sharp(placeholderPortrait(person.name, i)).png().toBuffer()
    const frame = await sharp({
      create: { width: box.w + 12, height: box.h + 12, channels: 3, background: '#111111' },
    })
      .png()
      .toBuffer()
    layers.push({ input: frame, left: box.x - 6, top: box.y - 6 })
    layers.push({ input: portrait, left: box.x, top: box.y })
    layers.push({ input: caption(person.name), left: box.x, top: box.y + box.h + 6 })
  }
  const image = await sharp({
    create: { width: layout.width, height: layout.height, channels: 3, background: '#fdf6e3' },
  })
    .composite(layers)
    .jpeg({ quality: 90 })
    .toBuffer()
  return { image, boxes: layout.boxes }
}

export async function readImageField(c: Context, field: string, maxBytes: number): Promise<Buffer> {
  const body = await c.req.parseBody()
  const file = body[field]
  if (!(file instanceof File)) throw new Error('לא הועלתה תמונה')
  if (file.size > maxBytes) throw new Error(`התמונה גדולה מדי (עד ${Math.round(maxBytes / 1024 / 1024)}MB)`)
  if (!file.type.startsWith('image/')) throw new Error('הקובץ חייב להיות תמונה')
  return Buffer.from(await file.arrayBuffer())
}
