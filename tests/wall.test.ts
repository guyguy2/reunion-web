import { describe, expect, it } from 'vitest'
import { WALL, wallLayout } from '../server/images.ts'
import { parseCsv } from '../server/people.ts'

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
