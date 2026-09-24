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
    const body = JSON.stringify({ secret: gmailRelaySecret, to, subject, text, ...(replyTo ? { replyTo } : {}) })
    // Redirects are followed by hand: fetch would follow them as a GET and drop the message.
    let url = gmailRelayUrl
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'manual' })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        // Google points at the script's answer only after the script has run.
        if (new URL(location).hostname === 'script.googleusercontent.com') return readRelayAnswer(fetchImpl, location)
        if (hop >= 2) throw new Error('Gmail relay redirected too many times')
        url = location
        continue
      }
      // Apps Script answers 200 even when the script fails, so the verdict is in the body.
      const result = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (!result?.ok) throw new Error(`Gmail relay answered ${res.status}${result?.error ? `: ${result.error}` : ''}`)
      return
    }
  }
}

/** The answer can be read only once, and now and then it is not there at all (a 404). The script has run by then,
 * so an unreadable answer counts as sent: failing would send a note alert twice, or show an error for a sign-in link that arrived. */
async function readRelayAnswer(fetchImpl: typeof fetch, answerUrl: string) {
  const res = await fetchImpl(answerUrl).catch(() => null)
  const result = res?.ok ? ((await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null) : null
  if (!result) {
    console.warn(`Gmail relay ran but its answer could not be read (${res?.status ?? 'no response'}); counting the email as sent`)
    return
  }
  if (!result.ok) throw new Error(`Gmail relay: ${result.error ?? 'failed'}`)
}

/** Resend when it has a key, else the Gmail relay, else null (no email). */
export function configuredMailer(config: Config, fetchImpl: typeof fetch = fetch): Mailer | null {
  return resendMailer(config, fetchImpl) ?? gmailRelayMailer(config, fetchImpl)
}
