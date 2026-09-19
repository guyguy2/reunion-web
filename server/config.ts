import path from 'node:path'

export interface Config {
  dataDir: string
  classPasscode: string
  adminPasscode: string
  sessionSecret: string
  port: number
  webDir: string
  secureCookies: boolean
  /** Feedback is emailed through Resend when both the key and the recipient are set. */
  resendApiKey?: string
  feedbackTo?: string
  feedbackFrom?: string
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
    feedbackFrom: process.env.FEEDBACK_FROM ?? 'Reunion site <onboarding@resend.dev>',
  }
}
