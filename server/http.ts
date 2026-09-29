import type { Context } from 'hono'

/** The JSON body when it is an object, else {} (bad JSON, null, a number, an array), so handlers can read its fields safely. */
export async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null)
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}
