// Sends the reunion site's emails from the Gmail account that owns this script.
// For a site without a domain verified in Resend; the server calls it over HTTPS (GMAIL_RELAY_URL).
//
// Setup, signed in to the Gmail account the emails should come from:
// 1. script.google.com > New project. Replace the code with this file and put the site's
//    GMAIL_RELAY_SECRET in SECRET below. SENDER_NAME is the name the emails come from. Save.
// 2. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
// 3. Authorize. Google warns the app is unverified: Advanced > Go to (project name). It asks only
//    to send email as you (MailApp), never to read your mail.
// 4. The "Web app" URL (ending in /exec) is GMAIL_RELAY_URL.
// After editing the code, Deploy > Manage deployments > edit > New version, or the old code keeps running.

const SECRET = 'PASTE_GMAIL_RELAY_SECRET_HERE'
const SENDER_NAME = 'אתר המחזור'

function doPost(e) {
  let data
  try {
    data = JSON.parse(e.postData.contents)
  } catch (err) {
    return reply({ ok: false, error: 'bad request' })
  }
  // "Anyone" can reach a web app, so every request must carry the secret the site was given.
  if (SECRET.startsWith('PASTE_') || data.secret !== SECRET) return reply({ ok: false, error: 'forbidden' })
  if (!data.to || !data.subject || !data.text) return reply({ ok: false, error: 'missing to, subject or text' })
  try {
    const options = { name: SENDER_NAME }
    if (data.replyTo) options.replyTo = data.replyTo
    // Mail apps show the HTML when there is one; the text is the fallback.
    if (data.html) options.htmlBody = data.html
    MailApp.sendEmail(data.to, data.subject, data.text, options)
  } catch (err) {
    return reply({ ok: false, error: String(err.message || err) })
  }
  return reply({ ok: true })
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON)
}
