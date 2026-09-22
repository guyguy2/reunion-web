import { describe, expect, it } from 'vitest'
import { WALL, wallLayout } from '../server/images.ts'
import { parseCsv } from '../server/people.ts'
import { parseAlbumPage } from '../server/album.ts'

describe('wallLayout', () => {
  it.each([1, 7, 60, 300])('fits %i portraits inside the image without overlap', (count) => {
    const { width, height, boxes, cols, rows } = wallLayout(count)
    expect(boxes).toHaveLength(count)
    expect(cols * rows).toBeGreaterThanOrEqual(count)
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(WALL.margin)
      expect(box.y).toBeGreaterThanOrEqual(WALL.margin)
      expect(box.x + box.w).toBeLessThanOrEqual(width - WALL.margin)
      expect(box.y + box.h + WALL.captionH).toBeLessThanOrEqual(height - WALL.margin)
    }
    const keys = new Set(boxes.map((b) => `${b.x},${b.y}`))
    expect(keys.size).toBe(count)
  })

  it('keeps a large class roughly landscape', () => {
    const { width, height } = wallLayout(300)
    expect(width / height).toBeGreaterThan(1.2)
    expect(width / height).toBeLessThan(2.2)
  })
})

describe('parseCsv', () => {
  it('handles quotes, embedded commas, CRLF and blank lines', () => {
    const rows = parseCsv('Name,Former Name\r\n"Smith, Jo","say ""hi"""\r\n\r\nLee,\r\n')
    expect(rows).toEqual([
      { name: 'Smith, Jo', former_name: 'say "hi"' },
      { name: 'Lee', former_name: '' },
    ])
  })
})

describe('parseAlbumPage', () => {
  it('extracts unique album photos with their sizes and ignores other images', () => {
    const html = `x ["https://lh3.googleusercontent.com/pw/AP1Gcz_a-B",4000,2252,null] y
      ["https://lh3.googleusercontent.com/pw/AP1Gcz_a-B",4000,2252] ["https://lh3.googleusercontent.com/pw/ZZtop9",1422,2047]
      ["https://lh3.googleusercontent.com/a/profile-pic",96,96] "https://lh3.googleusercontent.com/pw/no-size"`
    expect(parseAlbumPage(html)).toEqual([
      { src: 'https://lh3.googleusercontent.com/pw/ZZtop9', width: 1422, height: 2047 },
      { src: 'https://lh3.googleusercontent.com/pw/AP1Gcz_a-B', width: 4000, height: 2252 },
    ])
    expect(parseAlbumPage('<html>consent wall</html>')).toEqual([])
  })

  it('puts the most recently added photos first, whenever they were taken', () => {
    // Shaped like the real page: [id, [url, w, h, ..., [exif]], taken, key, tz offset, added, ...]
    const item = (id: string, taken: number, added: number) =>
      `["AF1Qip${id}",["https://lh3.googleusercontent.com/pw/${id}",800,600,null,null,[800,600,1,null,["Xiaomi","POCO",null,4.7]],[123]],${taken},"k-${id}",10800000,${added},["x"]]`
    const html = `[${item('old', 1490358321560, 1789820413120)},${item('scan', 1490358400000, 1790000000000)},${item('new', 1789900000000, 1789900000000)}]`
    expect(parseAlbumPage(html).map((p) => p.src.split('/pw/')[1])).toEqual(['scan', 'new', 'old'])
  })

  it('keeps every photo of an album well past the old 120 limit', () => {
    const html = Array.from({ length: 200 }, (_, i) => `["https://lh3.googleusercontent.com/pw/p${i}",10,10]`).join(' ')
    expect(parseAlbumPage(html)).toHaveLength(200)
  })
})
