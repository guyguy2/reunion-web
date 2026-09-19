// Applies a roster file (names, classes, genders and staff marks for the faces on the class photos) to the local database.
// The same file can be uploaded on the admin page instead.
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../server/db.ts'
import { importRoster, parseRoster } from '../server/roster.ts'

const file = process.argv[2]
if (!file) {
  console.error('Usage: pnpm roster:import <roster.json>')
  process.exit(1)
}
const db = openDb(path.resolve(process.env.DATA_DIR ?? './data'))
console.log(importRoster(db, parseRoster(JSON.parse(fs.readFileSync(file, 'utf8')))))
