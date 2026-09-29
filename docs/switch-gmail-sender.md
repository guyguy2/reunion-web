
# Switch the Gmail account that sends the site's emails

A one-time prompt for Claude Code. To run it: "follow @docs/switch-gmail-sender.md".

The user is moving the sender to a new Gmail account. No code changes are needed: the sender is whichever Google account deploys `scripts/gmail-relay.gs`. The work is in Google Apps Script (the user does it in the browser) and in Railway variables.

Before starting, check the facts below still hold (`server/email.ts`, `server/config.ts`, `scripts/gmail-relay.gs`, README env table). If something moved, say so and adapt.

## Facts

- `configuredMailer` in `server/email.ts` uses Resend when `RESEND_API_KEY` is set, else the Gmail relay (`GMAIL_RELAY_URL` + `GMAIL_RELAY_SECRET`). `RESEND_API_KEY` must stay unset.
- Every email goes through the relay: note alerts, sign-in links and feedback. All of them will come from the new address.
- `EMAIL_FROM` is Resend only. The relay's display name is the `SENDER_NAME` script property, or the script's default when it is not set.
- Older copies of the script had the secret in their code. To upgrade one of those deployments, add the `SECRET` script property first, then deploy the new version, otherwise every email fails with "SECRET script property is not set".
- Note alerts set no reply-to, so replies land in the new Gmail inbox.
- There is no local `.env` (only `.env.example`); the live values are Railway variables.
- Consumer Gmail via MailApp: about 100 recipients a day. A new account's first automated mail may go to spam.

## Steps

1. **Secret.** Ask whether to reuse the current `GMAIL_RELAY_SECRET` (default, one less variable to change) or make a new one.
   - Reuse: copy it to the clipboard without printing it:
     `railway variables --kv | rg '^GMAIL_RELAY_SECRET=' | cut -d= -f2- | tr -d '\n' | pbcopy`
   - New: `openssl rand -base64 32 | tr -d '\n' | tee >(pbcopy) >/dev/null` puts it on the clipboard only. Remind the user it must also go into Railway in step 3.
   - Never echo the secret into the conversation or write it into the repo copy of the script.

2. **New relay (user does this, signed in to the new Gmail account).** Give them the steps from the header of `scripts/gmail-relay.gs`:
   - script.google.com > New project, paste the file unchanged, save.
   - Project Settings (the gear) > Script Properties > Add script property: `SECRET` with the value from the clipboard. Optionally add `SENDER_NAME` for the display name. Save script properties. The secret lives only in the project's settings, never in the code.
   - Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Deploy.
   - Authorize; on the "unverified app" warning: Advanced > Go to (project name).
   - Copy the Web app URL ending in `/exec` and give it to Claude (the URL is not secret on its own, the secret guards it).

3. **Railway.** Confirm with the user before changing production variables. Check the CLI syntax first with `railway variables --help`, then set `GMAIL_RELAY_URL` to the new URL (and `GMAIL_RELAY_SECRET` if it is new). Make sure the service redeploys so it picks them up; `pnpm release` also does it.

4. **Test.** Send one message through the new relay to the user's own address, reading the secret from Railway so it is never printed (fill in URL and address):
   ```
   SECRET=$(railway variables --kv | rg '^GMAIL_RELAY_SECRET=' | cut -d= -f2-); jq -n --arg s "$SECRET" --arg to "ADDRESS" '{secret:$s,to:$to,subject:"Relay test",text:"Relay test from the new sender"}' | curl -sL --data @- -H 'Content-Type: application/json' "EXEC_URL"
   ```
   Expect `{"ok":true}` and the mail from the new account (check spam). Do not use `curl -X POST` with `-L`: the script runs on the POST and the answer must be fetched with a GET after the redirect. Then the user can leave a note on the live site to confirm end to end.

5. **Retire the old relay.** In the old Gmail account: script.google.com > the old project > Deploy > Manage deployments > Archive. If the secret was reused, the old endpoint would otherwise still send mail from the old address.

Nothing in the repo needs to change or be committed.
