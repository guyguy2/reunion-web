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

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'))
}

export function newEditToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function roleForPasscode(config: Config, passcode: string): Role | null {
  if (safeEqual(passcode, config.adminPasscode)) return 'admin'
  if (safeEqual(passcode, config.classPasscode)) return 'member'
  return null
}

export async function startSession(c: Context, config: Config, role: Role) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  await setSignedCookie(c, COOKIE, `${role}:${expires}`, config.sessionSecret, {
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
  const [role, expires] = value.split(':')
  if (role !== 'member' && role !== 'admin') return null
  if (!(Number(expires) > Date.now())) return null
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

// In-memory failed-login limiter. Fine for a single instance.
export function createLoginLimiter() {
  const failures = new Map<string, number[]>()
  const recent = (key: string) => {
    const cutoff = Date.now() - FAILURE_WINDOW_MS
    const list = (failures.get(key) ?? []).filter((t) => t > cutoff)
    failures.set(key, list)
    return list
  }
  return {
    blocked: (key: string) => recent(key).length >= MAX_FAILURES,
    fail: (key: string) => void recent(key).push(Date.now()),
    clear: (key: string) => void failures.delete(key),
  }
}

export function clientKey(c: Context): string {
  return c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}
