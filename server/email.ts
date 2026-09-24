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

/**
 * Sends email from a Gmail account through a Google Apps Script web app (scripts/gmail-relay.gs), or returns null
 * when it is not set up. For a site without a domain verified in Resend. It works over HTTPS, which Railway allows
 * on every plan (SMTP it does not). The shared secret keeps anyone who finds the URL from sending mail as that account.
 */
export function gmailRelayMailer(config: Config, fetchImpl: typeof fetch = fetch): Mailer | null {
  const { gmailRelayUrl, gmailRelaySecret } = config
  if (!gmailRelayUrl || !gmailRelaySecret) return null
  return async ({ to, subject, text, replyTo }) => {
    const res = await fetchImpl(gmailRelayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: gmailRelaySecret, to, subject, text, ...(replyTo ? { replyTo } : {}) }),
    })
    // Apps Script answers 200 even when the script fails, so the verdict is in the body.
    const result = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!res.ok || !result?.ok) throw new Error(`Gmail relay answered ${res.status}${result?.error ? `: ${result.error}` : ''}`)
  }
}

/** Resend when it has a key, else the Gmail relay, else null (no email). */
export function configuredMailer(config: Config, fetchImpl: typeof fetch = fetch): Mailer | null {
  return resendMailer(config, fetchImpl) ?? gmailRelayMailer(config, fetchImpl)
}
