import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../server/db.ts'
import { SiteNotEmptyError, loadDemoData } from '../server/demo.ts'
import { insertPerson } from '../server/people.ts'

const dirs: string[] = []
function freshSite() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunion-demo-'))
  dirs.push(dataDir)
  return { dataDir, db: openDb(dataDir) }
}

const count = (db: Db, table: 'people' | 'scenes') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadDemoData', () => {
  it('refuses a site that has a class photo but no people yet', async () => {
    const { dataDir, db } = freshSite()
    db.prepare(`INSERT INTO scenes (slug, title, kind, width, height, tiles_path) VALUES ('prom', 'Prom', 'group', 600, 400, 'scenes/prom')`).run()
    await expect(loadDemoData(db, dataDir)).rejects.toThrow('רק לאתר ריק')
    expect(count(db, 'people')).toBe(0)
    expect(count(db, 'scenes')).toBe(1)
  })

  it('refuses a site that already has a person, writing nothing', async () => {
    const { dataDir, db } = freshSite()
    insertPerson(db, { name: 'Jenny Carter' })
    await expect(loadDemoData(db, dataDir)).rejects.toThrow(SiteNotEmptyError)
    expect(count(db, 'people')).toBe(1)
    expect(count(db, 'scenes')).toBe(0)
  })

  it('fills an empty site', async () => {
    const { dataDir, db } = freshSite()
    await loadDemoData(db, dataDir)
    expect(count(db, 'people')).toBe(60)
    expect(count(db, 'scenes')).toBe(2)
  }, 60_000)
})
