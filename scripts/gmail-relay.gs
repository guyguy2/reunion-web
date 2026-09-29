// Sends the reunion site's emails from the Gmail account that owns this script.
// For a site without a domain verified in Resend; the server calls it over HTTPS (GMAIL_RELAY_URL).
//
// Setup, signed in to the Gmail account the emails should come from:
// 1. script.google.com > New project. Replace the code with this file and save. The file holds no secret.
// 2. Project Settings (the gear) > Script Properties > Add script property. Property: SECRET, value: the
//    site's GMAIL_RELAY_SECRET. Optionally add SENDER_NAME, the name the emails come from (default below).
//    Save script properties.
// 3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
// 4. Authorize. Google warns the app is unverified: Advanced > Go to (project name). It asks only
//    to send email as you (MailApp), never to read your mail.
// 5. The "Web app" URL (ending in /exec) is GMAIL_RELAY_URL.
// After editing the code, Deploy > Manage deployments > edit > New version, or the old code keeps running.
// Script properties are read on every request, so changing them needs no new version.

const DEFAULT_SENDER_NAME = 'אתר המחזור'

function doPost(e) {
  const props = PropertiesService.getScriptProperties()
  const secret = props.getProperty('SECRET')
  if (!secret) return reply({ ok: false, error: 'SECRET script property is not set' })
  let data
  try {
    data = JSON.parse(e.postData.contents)
  } catch (err) {
    return reply({ ok: false, error: 'bad request' })
  }
  if (!data || typeof data !== 'object') return reply({ ok: false, error: 'bad request' })
  // "Anyone" can reach a web app, so every request must carry the secret the site was given.
  if (data.secret !== secret) return reply({ ok: false, error: 'forbidden' })
  if (!data.to || !data.subject || !data.text) return reply({ ok: false, error: 'missing to, subject or text' })
  try {
    const options = { name: props.getProperty('SENDER_NAME') || DEFAULT_SENDER_NAME }
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
