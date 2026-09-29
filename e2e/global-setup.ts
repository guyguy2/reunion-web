import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

/** Builds the demo database once; every spec file's server then starts from a copy of it. */
export default async function globalSetup() {
  for (const file of ['dist/server/index.js', 'dist/web/index.html']) {
    if (!existsSync(path.join(root, file))) throw new Error(`${file} is missing: run pnpm build first (pnpm test:e2e does).`)
  }
  const template = await mkdtemp(path.join(os.tmpdir(), 'reunion-e2e-template-'))
  try {
    await seed(template)
  } catch (err) {
    await rm(template, { recursive: true, force: true })
    throw err
  }
  process.env.E2E_TEMPLATE_DIR = template
  return () => rm(template, { recursive: true, force: true })
}

function seed(dataDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Clean env, so a developer's shell can never point the seed at real data or services.
    const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['scripts/seed.ts'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATA_DIR: dataDir },
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Seeding the demo data failed (exit ${code}):\n${output}`))))
  })
}
