import sharp, { type OverlayOptions } from 'sharp'
import type { Db } from './db.ts'
import { saveUpload, type Box } from './images.ts'
import { insertPerson } from './people.ts'
import { addGroupScene, insertTag, rebuildWall } from './scenes.ts'

const FIRST = ['Jennifer', 'Michael', 'Jessica', 'Chris', 'Amanda', 'Josh', 'Ashley', 'Matt', 'Sarah', 'Brian', 'Stephanie', 'Kevin', 'Nicole', 'Jason', 'Heather', 'Ryan', 'Melissa', 'Eric', 'Tiffany', 'Justin']
const LAST = ['Carter', 'Nguyen', 'Alvarez', 'Thompson', 'Kowalski', 'Bennett', 'Okafor', 'Sullivan', 'Rivera', 'Goldberg', 'Patel', 'Morrison', 'Kim', 'Fitzgerald', 'Dawson']
const CITIES = ['Seattle, WA', 'Austin, TX', 'Chicago, IL', 'Brooklyn, NY', 'Denver, CO', 'Portland, OR', 'Still in town', 'London, UK', 'Tel Aviv, IL']
const QUOTES = ['As if!', 'Talk to the hand.', 'Be kind, rewind.', 'Most likely to still own a pager.', 'Carpe diem, or whatever.', 'See you on the information superhighway.']
const BIOS = [
  'Traded the marching band for a desk job. Still knows every word to the fight song.',
  'Two kids, one dog, zero regrets about the frosted tips.',
  'Runs a small bakery now. The cafeteria cookies were the inspiration.',
  'Moved away, came back, moved away again. Always up for a reunion.',
]
const SKIN = ['#f6d3b3', '#e8b98f', '#c98d5f', '#9b6a43', '#6f4a2d', '#fbe0c8']
const HAIR = ['#2b1b10', '#5a3a1e', '#a86a2c', '#e0b64c', '#c0392b', '#111111']
const BACKDROP = ['#7dd3c8', '#f9a8d4', '#c4b5fd', '#fde68a', '#93c5fd', '#fdba74']
const SHIRT = ['#ec4899', '#14b8a6', '#8b5cf6', '#f59e0b', '#ef4444', '#2563eb', '#111111']

const PEOPLE = 60
const GROUP = { width: 4800, height: 2700, cols: 12, rows: 4, faceW: 260, faceH: 325 }
const UNIDENTIFIED = new Set([5, 17, 22, 30, 41, 46])

// Small deterministic generator so the demo looks the same every time.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

/** A cartoon yearbook portrait. No text, so it renders the same with or without system fonts. */
function portraitSvg(i: number, opts: { backdrop: boolean; aged?: boolean }): string {
  const r = rng(i * 7919 + 13)
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)]
  const skin = pick(SKIN)
  const hair = opts.aged && r() > 0.5 ? '#9ca3af' : pick(HAIR)
  const shirt = pick(SHIRT)
  const backdrop = pick(BACKDROP)
  const longHair = r() > 0.5
  const glasses = opts.aged ? r() > 0.4 : r() > 0.8
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400" viewBox="0 0 320 400">
    ${opts.backdrop ? `<rect width="320" height="400" fill="${backdrop}"/><circle cx="60" cy="70" r="26" fill="#fff" fill-opacity=".35"/><path d="M230 40 l40 20 -40 20z" fill="#fff" fill-opacity=".35"/>` : ''}
    ${longHair ? `<path d="M70 180 C60 60 260 60 250 180 L262 330 L58 330 Z" fill="${hair}"/>` : ''}
    <path d="M30 400 C30 300 290 300 290 400 Z" fill="${shirt}"/>
    <rect x="138" y="250" width="44" height="60" rx="18" fill="${skin}"/>
    <ellipse cx="160" cy="185" rx="78" ry="92" fill="${skin}"/>
    <path d="M82 170 C80 70 240 70 238 170 C210 120 120 115 82 170 Z" fill="${hair}"/>
    <circle cx="130" cy="190" r="8" fill="#111"/><circle cx="190" cy="190" r="8" fill="#111"/>
    ${glasses ? `<g fill="none" stroke="#111" stroke-width="5"><circle cx="130" cy="190" r="22"/><circle cx="190" cy="190" r="22"/><path d="M152 190h16"/></g>` : ''}
    <path d="M128 232 Q160 262 192 232" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>
    <circle cx="112" cy="218" r="10" fill="#f472b6" fill-opacity=".45"/><circle cx="208" cy="218" r="10" fill="#f472b6" fill-opacity=".45"/>
  </svg>`
}

async function groupPhoto(): Promise<{ image: Buffer; boxes: Box[] }> {
  const { width, height, cols, rows, faceW, faceH } = GROUP
  const layers: OverlayOptions[] = []
  const boxes: Box[] = []
  const stepX = (width - 400) / cols
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col
      const left = Math.round(200 + col * stepX + (row % 2 ? stepX / 3 : 0) + (stepX - faceW) / 2 - stepX / 6)
      const top = Math.round(420 + row * 480)
      const face = await sharp(Buffer.from(portraitSvg(i, { backdrop: false }))).resize(faceW, faceH).png().toBuffer()
      layers.push({ input: face, left, top })
      // Tag the head, not the shoulders.
      boxes.push({ x: left + faceW * 0.2, y: top + faceH * 0.15, w: faceW * 0.6, h: faceH * 0.58 })
    }
  }
  const bleachers = Array.from({ length: rows }, (_, row) =>
    `<rect x="120" y="${720 + row * 480}" width="${width - 240}" height="60" fill="#8b5a2b"/><rect x="120" y="${780 + row * 480}" width="${width - 240}" height="16" fill="#5c3a1a"/>`,
  ).join('')
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset="1" stop-color="#fcd9a0"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#wall)"/>
      <rect y="${height - 260}" width="100%" height="260" fill="#d9a066"/>
      <rect x="1500" y="90" width="1800" height="220" rx="24" fill="#ec4899" stroke="#111" stroke-width="12"/>
      <path d="M1580 200 h1640" stroke="#fde68a" stroke-width="28" stroke-dasharray="70 40"/>
      ${bleachers}
    </svg>`,
  )
  const image = await sharp(background).composite(layers).jpeg({ quality: 90 }).toBuffer()
  return { image, boxes }
}

/** Fills an empty site with fake classmates, a portrait wall and a tagged group photo. */
export async function loadDemoData(db: Db, dataDir: string) {
  const r = rng(1996)
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)]
  const ids: number[] = []
  for (let i = 0; i < PEOPLE; i++) {
    const first = FIRST[i % FIRST.length]
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]
    const filledIn = i % 3 === 0
    const thenPhoto = await saveUpload(dataDir, await sharp(Buffer.from(portraitSvg(i, { backdrop: true }))).png().toBuffer())
    const nowPhoto = filledIn
      ? await saveUpload(dataDir, await sharp(Buffer.from(portraitSvg(i, { backdrop: true, aged: true }))).png().toBuffer())
      : null
    const handle = `${first}.${last}`.toLowerCase()
    ids.push(
      insertPerson(db, {
        name: `${first} ${last}`,
        nickname: i % 9 === 0 ? `${first.slice(0, 3)}ster` : null,
        former_name: i % 11 === 0 ? pick(LAST) : null,
        then_photo: thenPhoto,
        now_photo: nowPhoto,
        quote: pick(QUOTES),
        ...(filledIn
          ? {
              email: `${handle}@example.com`,
              instagram: handle.replace('.', '_'),
              city: pick(CITIES),
              bio: pick(BIOS),
              attending: pick(['yes', 'yes', 'maybe', 'no']),
              // Demo profiles count as claimed but have no edit token, so nobody can edit them.
              claimed_at: new Date().toISOString(),
            }
          : {}),
      }),
    )
  }
  await rebuildWall(db, dataDir)
  const { image, boxes } = await groupPhoto()
  const sceneId = await addGroupScene(db, dataDir, 'Senior class photo', image)
  boxes.forEach((box, i) => insertTag(db, sceneId, box, UNIDENTIFIED.has(i) ? null : ids[i]))
}
