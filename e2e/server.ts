import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

export const PASSCODES = { member: 'class-e2e-passcode', admin: 'admin-e2e-passcode' } as const

export interface RunningServer {
  /** http://127.0.0.1:<port>, no trailing slash. */
  url: string
  /** This server's private copy of the demo data. */
  dataDir: string
  /** Captured stdout and stderr so far. */
  output(): string
  /** SIGTERM, wait for exit, remove dataDir. */
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/** Starts the built server on a free port with its own copy of the demo data (E2E_TEMPLATE_DIR, made by global setup). */
export async function startServer(opts: { env?: Record<string, string> } = {}): Promise<RunningServer> {
  const template = process.env.E2E_TEMPLATE_DIR
  if (!template) throw new Error('E2E_TEMPLATE_DIR is not set: the Playwright global setup did not run.')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'reunion-e2e-data-'))
  await cp(template, dataDir, { recursive: true })
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`

  // Built from scratch: nothing from the developer's shell (mail keys, event details, Railway) can reach the server.
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATA_DIR: dataDir,
      WEB_DIR: path.join(root, 'dist/web'),
      PORT: String(port),
      CLASS_PASSCODE: PASSCODES.member,
      ADMIN_PASSCODE: PASSCODES.admin,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      PUBLIC_URL: url,
      ...opts.env,
    },
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const spawnFailed = new Promise<never>((_, reject) => child.once('error', reject))
  spawnFailed.catch(() => {})

  // Best effort if the worker is killed hard: don't leave the server running. Removed again in stop().
  const killChild = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  process.on('exit', killChild)

  const stop = async () => {
    process.off('exit', killChild)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      // A server that ignores SIGTERM would hang the run, so escalate after a few seconds.
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    await rm(dataDir, { recursive: true, force: true })
  }

  try {
    const deadline = Date.now() + 15_000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('The server exited before it was ready.')
      if (Date.now() > deadline) throw new Error('The server was not ready within 15 seconds.')
      const ok = await Promise.race([fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) }).then((res) => res.ok, () => false), spawnFailed])
      if (ok) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } catch (err) {
    await stop()
    throw new Error(`${(err as Error).message}\n--- server output ---\n${output}`)
  }
  return { url, dataDir, output: () => output, stop }
}
