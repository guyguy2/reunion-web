// Loads demo classmates, the portrait wall and a tagged group photo into an empty local database.
import path from 'node:path'
import { openDb } from '../server/db.ts'
import { loadDemoData } from '../server/demo.ts'

const dataDir = path.resolve(process.env.DATA_DIR ?? './data')
const db = openDb(dataDir)
const { n } = db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }
if (n > 0) {
  console.error(`Database already has ${n} people. Remove ${dataDir} first if you want a fresh demo.`)
  process.exit(1)
}
await loadDemoData(db, dataDir)
console.log(`Demo data loaded into ${dataDir}`)
