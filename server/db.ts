import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export type Db = DatabaseSync

export interface PersonRow {
  id: number
  name: string
  former_name: string | null
  nickname: string | null
  email: string | null
  instagram: string | null
  linkedin: string | null
  city: string | null
  bio: string | null
  quote: string | null
  then_photo: string | null
  now_photo: string | null
  attending: string | null
  in_memoriam: number
  show_email: number
  show_instagram: number
  show_linkedin: number
  claimed_at: string | null
  edit_token_hash: string | null
}

export interface SceneRow {
  id: number
  slug: string
  title: string
  kind: 'mosaic' | 'group'
  width: number
  height: number
  tiles_path: string
  sort: number
}

export interface TagRow {
  id: number
  scene_id: number
  person_id: number | null
  x: number
  y: number
  w: number
  h: number
}

// Each entry runs once, in order. Append only; never edit a shipped migration.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    former_name TEXT,
    nickname TEXT,
    email TEXT,
    instagram TEXT,
    linkedin TEXT,
    city TEXT,
    bio TEXT,
    quote TEXT,
    then_photo TEXT,
    now_photo TEXT,
    attending TEXT CHECK (attending IN ('yes', 'no', 'maybe')),
    in_memoriam INTEGER NOT NULL DEFAULT 0,
    show_email INTEGER NOT NULL DEFAULT 1,
    show_instagram INTEGER NOT NULL DEFAULT 1,
    show_linkedin INTEGER NOT NULL DEFAULT 1,
    claimed_at TEXT,
    edit_token_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE scenes (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('mosaic', 'group')),
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    tiles_path TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL
  );
  CREATE INDEX tags_scene ON tags(scene_id);
  CREATE INDEX tags_person ON tags(person_id);
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
]

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'reunion.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

function migrate(db: Db) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export function bumpCounter(db: Db, key: string): number {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
  ).run(key)
  return getCounter(db, key)
}

export function getCounter(db: Db, key: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? Number(row.value) : 0
}
