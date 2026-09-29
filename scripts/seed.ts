// Loads demo classmates, the portrait wall and a tagged group photo into an empty local database.
import path from 'node:path'
import { openDb } from '../server/db.ts'
import { SiteNotEmptyError, loadDemoData } from '../server/demo.ts'

const dataDir = path.resolve(process.env.DATA_DIR ?? './data')
const db = openDb(dataDir)
try {
  await loadDemoData(db, dataDir)
} catch (err) {
  if (!(err instanceof SiteNotEmptyError)) throw err
  console.error(err.message)
  console.error(`Remove ${dataDir} first if you want a fresh demo.`)
  process.exit(1)
}
console.log(`Demo data loaded into ${dataDir}`)
