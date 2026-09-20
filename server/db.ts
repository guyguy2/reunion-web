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
  facebook: string | null
  website: string | null
  phone: string | null
  x: string | null
  city: string | null
  bio: string | null
  quote: string | null
  then_photo: string | null
  now_photo: string | null
  attending: string | null
  gender: 'm' | 'f' | null
  in_memoriam: number
  show_email: number
  show_instagram: number
  show_linkedin: number
  show_facebook: number
  show_website: number
  show_phone: number
  show_x: number
  claimed_at: string | null
  edit_token_hash: string | null
  pin_hash: string | null
  /** Attached by getPerson/listPeople, not a column. Oldest first; the first of each kind is the primary. */
  photos?: PersonPhotoRow[]
}

export type PhotoKind = 'then' | 'now'

export interface PersonPhotoRow {
  id: number
  person_id: number
  kind: PhotoKind
  path: string
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
  /** The year the picture is from, for filtering. Read from a title that starts with one. */
  year: number | null
}

export interface TagRow {
  id: number
  scene_id: number
  person_id: number | null
  x: number
  y: number
  w: number
  h: number
  /** The name printed under the face on the poster, e.g. an initial and a surname. */
  caption: string | null
  class_label: string | null
  /** Staff faces stay in the database but are left out of the yearbook. */
  is_staff: number
}

export interface TapeRow {
  id: number
  provider: 'youtube' | 'spotify'
  kind: string
  external_id: string
  title: string
  added_by: string | null
  created_at: string
}

export interface VideoRow {
  id: number
  provider: 'youtube' | 'instagram' | 'facebook' | 'x'
  external_id: string
  title: string
  note: string | null
  added_by: string | null
  created_at: string
}

export interface FeedbackRow {
  id: number
  message: string
  sender: string | null
  emailed: number
  created_at: string
}

export interface QuoteRow {
  id: number
  text: string
  said_by: string | null
  context: string | null
  added_by: string | null
  created_at: string
}

export interface QuoteCommentRow {
  id: number
  quote_id: number
  message: string
  added_by: string | null
  created_at: string
}

/** sender_id and sender_name are both null for an anonymous note. */
export interface NoteRow {
  id: number
  recipient_id: number
  sender_id: number | null
  sender_name: string | null
  message: string
  read_at: string | null
  created_at: string
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
  `
  CREATE TABLE tapes (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('youtube', 'spotify')),
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    added_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, kind, external_id)
  );
  `,
  `
  CREATE TABLE videos (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('youtube', 'instagram', 'facebook', 'x')),
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    note TEXT,
    added_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, external_id)
  );
  `,
  `
  ALTER TABLE people ADD COLUMN facebook TEXT;
  ALTER TABLE people ADD COLUMN website TEXT;
  ALTER TABLE people ADD COLUMN show_facebook INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE people ADD COLUMN show_website INTEGER NOT NULL DEFAULT 1;
  `,
  `
  ALTER TABLE people ADD COLUMN phone TEXT;
  ALTER TABLE people ADD COLUMN show_phone INTEGER NOT NULL DEFAULT 1;
  `,
  `
  ALTER TABLE people ADD COLUMN x TEXT;
  ALTER TABLE people ADD COLUMN show_x INTEGER NOT NULL DEFAULT 1;
  `,
  `
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY,
    message TEXT NOT NULL,
    sender TEXT,
    emailed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    recipient_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    sender_name TEXT,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX notes_recipient ON notes(recipient_id);
  `,
  `
  ALTER TABLE people ADD COLUMN pin_hash TEXT;
  CREATE TABLE device_tokens (
    token_hash TEXT PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE TABLE recovery_tokens (
    token_hash TEXT PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    said_by TEXT,
    context TEXT,
    added_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE quote_comments (
    id INTEGER PRIMARY KEY,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    added_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX quote_comments_quote ON quote_comments(quote_id);
  `,
  `
  ALTER TABLE people ADD COLUMN gender TEXT CHECK (gender IN ('m', 'f'));
  ALTER TABLE scenes ADD COLUMN year INTEGER;
  UPDATE scenes SET year = CAST(substr(title, 1, 4) AS INTEGER) WHERE title GLOB '[12][0-9][0-9][0-9]*';
  ALTER TABLE tags ADD COLUMN caption TEXT;
  ALTER TABLE tags ADD COLUMN class_label TEXT;
  ALTER TABLE tags ADD COLUMN is_staff INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE quote_reactions (
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    reactor TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (quote_id, reactor)
  );
  `,
  `
  CREATE TABLE person_photos (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('then', 'now')),
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX person_photos_person ON person_photos(person_id);
  INSERT INTO person_photos (person_id, kind, path) SELECT id, 'then', then_photo FROM people WHERE then_photo IS NOT NULL;
  INSERT INTO person_photos (person_id, kind, path) SELECT id, 'now', now_photo FROM people WHERE now_photo IS NOT NULL;
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

/** Free-form settings, for the bits of the site the organizers edit from the site itself. */
export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setMeta(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function getCounter(db: Db, key: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row ? Number(row.value) : 0
}
