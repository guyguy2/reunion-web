import path from 'node:path'

export interface Config {
  dataDir: string
  classPasscode: string
  adminPasscode: string
  sessionSecret: string
  port: number
  webDir: string
  secureCookies: boolean
  /** Email goes through Resend when a key is set, else through the Gmail relay when its URL and secret are:
   * feedback to FEEDBACK_TO, sign-in links and note alerts to the profile's address. */
  resendApiKey?: string
  feedbackTo?: string
  emailFrom?: string
  gmailRelayUrl?: string
  gmailRelaySecret?: string
  /** The site's public address, for links in emails. Falls back to the address of the request. */
  publicUrl?: string
  /** Deploy time and commit, set by `pnpm release`. Shown in the principal's office. */
  version?: string
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

export function loadConfig(): Config {
  return {
    dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
    classPasscode: required('CLASS_PASSCODE'),
    adminPasscode: required('ADMIN_PASSCODE'),
    sessionSecret: required('SESSION_SECRET'),
    port: Number(process.env.PORT ?? 3000),
    webDir: path.resolve(process.env.WEB_DIR ?? './dist/web'),
    secureCookies: process.env.NODE_ENV === 'production',
    resendApiKey: process.env.RESEND_API_KEY,
    feedbackTo: process.env.FEEDBACK_TO,
    emailFrom: process.env.EMAIL_FROM ?? 'Reunion site <onboarding@resend.dev>',
    gmailRelayUrl: process.env.GMAIL_RELAY_URL,
    gmailRelaySecret: process.env.GMAIL_RELAY_SECRET,
    publicUrl: process.env.PUBLIC_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    version: process.env.APP_VERSION,
  }
}
