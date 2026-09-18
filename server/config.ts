import path from 'node:path'

export interface Config {
  dataDir: string
  classPasscode: string
  adminPasscode: string
  sessionSecret: string
  port: number
  webDir: string
  secureCookies: boolean
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
  }
}
