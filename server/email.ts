import type { Config } from './config.ts'

export type Mailer = (message: { to: string; subject: string; text: string; replyTo?: string }) => Promise<void>

/**
 * Sends email through Resend's HTTP API, or returns null when no API key is set.
 * Resend's test sender (onboarding@resend.dev) only delivers to the Resend account's own address;
 * mail to classmates needs EMAIL_FROM on a domain verified in Resend.
 */
export function resendMailer(config: Config, fetchImpl: typeof fetch = fetch): Mailer | null {
  const { resendApiKey, emailFrom } = config
  if (!resendApiKey) return null
  return async ({ to, subject, text, replyTo }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: emailFrom, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    })
    if (!res.ok) throw new Error(`Resend answered ${res.status}`)
  }
}
