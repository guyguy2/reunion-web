import crypto from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { Config } from './config.ts'

export type Role = 'member' | 'admin'
export type AppEnv = { Variables: { role: Role } }

const COOKIE = 'reunion_session'
const SESSION_DAYS = 90
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'))
}

const PIN_MIN = 4
const PIN_MAX = 40

/** A personal code for signing in on another device. Stored as salted scrypt, never as the code itself. */
export function hashPin(pin: string): string {
  const code = pin.trim()
  if (code.length < PIN_MIN) throw new Error(`הקוד צריך להיות לפחות ${PIN_MIN} תווים`)
  if (code.length > PIN_MAX) throw new Error('הקוד ארוך מדי')
  const salt = crypto.randomBytes(16).toString('hex')
  return `${salt}:${crypto.scryptSync(code, salt, 32).toString('hex')}`
}

export function verifyPin(pin: string, stored: string | null): boolean {
  if (!stored) return false
  const [salt, hash] = stored.split(':')
  const attempt = crypto.scryptSync(pin.trim(), salt, 32)
  return crypto.timingSafeEqual(attempt, Buffer.from(hash, 'hex'))
}

export function newEditToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function roleForPasscode(config: Config, passcode: string): Role | null {
  if (safeEqual(passcode, config.adminPasscode)) return 'admin'
  if (safeEqual(passcode, config.classPasscode)) return 'member'
  return null
}

/** Goes into the session cookie, so changing a role's passcode ends that role's sessions. Keyed with the session
 * secret, so a copied cookie does not give away a plain hash of the passcode to guess against. */
const passcodeHash = (config: Config, role: Role) =>
  crypto.createHmac('sha256', config.sessionSecret).update(role === 'admin' ? config.adminPasscode : config.classPasscode).digest('hex')

export async function startSession(c: Context, config: Config, role: Role) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  await setSignedCookie(c, COOKIE, `${role}:${expires}:${passcodeHash(config, role)}`, config.sessionSecret, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.secureCookies,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })
}

export function endSession(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' })
}

export async function readRole(c: Context, config: Config): Promise<Role | null> {
  const value = await getSignedCookie(c, config.sessionSecret, COOKIE)
  if (!value) return null
  const [role, expires, hash] = value.split(':')
  if (role !== 'member' && role !== 'admin') return null
  if (!(Number(expires) > Date.now())) return null
  if (hash !== passcodeHash(config, role)) return null
  return role
}

export function requireSession(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const role = await readRole(c, config)
    if (!role) return c.json({ error: 'נדרשת סיסמה' }, 401)
    c.set('role', role)
    await next()
  }
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'למארגנים בלבד' }, 403)
  await next()
}

/** The times in `map` under `key` that are after `cutoff`. A key left with none is deleted rather than kept empty. */
function recentTimes(map: Map<string, number[]>, key: string, cutoff: number): number[] {
  const list = (map.get(key) ?? []).filter((t) => t > cutoff)
  if (list.length) map.set(key, list)
  else map.delete(key)
  return list
}

// In-memory failed-login limiter. Fine for a single instance.
export function createLoginLimiter() {
  const failures = new Map<string, number[]>()
  const recent = (key: string) => recentTimes(failures, key, Date.now() - FAILURE_WINDOW_MS)
  return {
    blocked: (key: string) => recent(key).length >= MAX_FAILURES,
    fail: (key: string) => void failures.set(key, [...recent(key), Date.now()]),
    clear: (key: string) => void failures.delete(key),
    /** How many keys it is holding. */
    size: () => failures.size,
  }
}

/** Sliding-window throttle: at most `max` hits per key per `windowMs`, and at most `globalMax` hits in total per window when given. */
export function createThrottle(opts: { max: number; windowMs: number; globalMax?: number }) {
  const hits = new Map<string, number[]>()
  let everyone: number[] = []
  return {
    /** Records the hit when allowed. */
    allow(key: string): boolean {
      const now = Date.now()
      const cutoff = now - opts.windowMs
      const mine = recentTimes(hits, key, cutoff)
      everyone = everyone.filter((t) => t > cutoff)
      if (mine.length >= opts.max || everyone.length >= (opts.globalMax ?? Infinity)) return false
      hits.set(key, [...mine, now])
      if (opts.globalMax !== undefined) everyone.push(now)
      return true
    },
    clear: (key: string) => void hits.delete(key),
    /** How many keys it is holding. */
    size: () => hits.size,
  }
}

/**
 * Failed guesses against one key, with a block that grows: after MAX_FAILURES in the window the key is blocked for
 * FAILURE_WINDOW_MS, and each wrong guess after a block doubles the next one, up to a day. The right guess clears it,
 * and a day after its last block ran out the key starts over. In memory, like the limiter.
 */
export function createLockout() {
  const entries = new Map<string, { failures: number[]; blocks: number; until: number }>()
  const current = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return undefined
    const now = Date.now()
    entry.failures = entry.failures.filter((t) => t > now - FAILURE_WINDOW_MS)
    if (entry.failures.length === 0 && entry.until + MAX_LOCKOUT_MS <= now) {
      entries.delete(key)
      return undefined
    }
    return entry
  }
  return {
    blocked: (key: string) => (current(key)?.until ?? 0) > Date.now(),
    fail(key: string) {
      const now = Date.now()
      const entry = current(key) ?? { failures: [], blocks: 0, until: 0 }
      entries.set(key, entry)
      if (entry.blocks === 0) {
        entry.failures.push(now)
        if (entry.failures.length < MAX_FAILURES) return
      }
      entry.until = now + Math.min(FAILURE_WINDOW_MS * 2 ** entry.blocks, MAX_LOCKOUT_MS)
      entry.blocks++
    },
    clear: (key: string) => void entries.delete(key),
  }
}

/**
 * The client's address. Railway's edge proxy sets X-Real-IP to the address it saw, and does not set X-Forwarded-For,
 * so on Railway x-forwarded-for can arrive just as the client wrote it. The last x-forwarded-for hop is only a fallback
 * for a proxy that sets no X-Real-IP.
 */
export function clientKey(c: Context): string {
  return c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local'
}
