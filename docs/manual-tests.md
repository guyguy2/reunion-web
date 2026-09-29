# Manual tests after a deploy

What to click through on the live site after `pnpm release`. The automated suite (`pnpm typecheck && pnpm test`) covers the server routes end to end on a temporary database, and the client only through pure helpers, so the browser checks below matter most for anything in `web/`. `pnpm test:e2e` also drives the client in a real browser against demo data on a throwaway local server; it never touches the live site. `pnpm test:e2e` builds the site and runs the suite, and `pnpm exec playwright test --ui` shows it clicking through. On a new machine run `pnpm exec playwright install chromium` once. Always go through pnpm: a globally installed playwright of another version breaks the run. The checks below are what the suite cannot do: real email, real YouTube and Spotify playback, automatic face detection, a real phone, and the live site with its real data.

## Before deploying

- Take a volume backup in the Railway dashboard and download an admin backup export.
- Note the version shown in the principal's office. If something is wrong, redeploy the previous deployment from Railway and compare.
- Create a test profile for the destructive checks (merge, remove my info). Never use a real classmate's profile.
- A change to session handling may ask everyone for the class passcode once. That is expected.

## Server

| Area | Do | Expect |
|---|---|---|
| Login limiter | Enter the wrong class passcode until blocked, then the right one | Blocked message in Hebrew, success again after the lockout |
| Admin limiter | Wrong admin passcode a few times, then a correct class login | The admin lockout does not clear when the class login succeeds |
| Sign-in link | Request a link twice fast, then a third time | The third is throttled with a Hebrew message; the first email arrives |
| Feedback | Send two feedback notes quickly, then a burst of five | Later ones throttled, the first ones appear in the admin inbox |
| Passcode change | Set `CLASS_PASSCODE` on Railway (the README shows the command) and redeploy, then reload the site in another browser | That browser asks for the new passcode, and the old passcode is refused |
| Demo load | In admin, try to load demo data on the live site | Refused with a clear message, nothing changes |
| Backup export | Download an export | Includes people, photos, quotes, comments, tapes, videos, credits |
| Remove my info | Fill in everything on the test profile, then remove | Name stays, everything else is gone, the profile can be claimed again |
| CSV import | Import a two-row CSV with `y` and `no` in flag columns | Flags read correctly, existing names are skipped |
| Merge | Merge the test profile into a second test profile | Photos, notes and hidden contact fields follow the merge |

## Client

| Area | Do | Expect |
|---|---|---|
| Roster | Mark a face as staff, then press the next shortcut at once | One action at a time, no jump in the list |
| Admin | Start a CSV import and click "add person" during it | The second button stays disabled until the first finishes |
| Tagger | Draw a box, then go offline before it saves | Hebrew message, the box is removed, retry works when back online |
| Face detection | In the tagger on a group photo, press automatic face detection | Faces are found as boxes (the model loads from a CDN); a wrong box can be deleted |
| Tapes | Play a YouTube tape and a Spotify tape, and let one end | The sound plays, and the next tape starts when one ends |
| Videos | Play a YouTube video on the videos page | It plays in the page |
| Contact links | On a phone, save an email like `a@b` in the claim form and in the profile form | The browser's own check may let it through; the server then refuses it with a Hebrew message and nothing is saved |
| Notes | Send a note while offline | Error shown, the note can be resent |
| Phone | Open the yearbook, a profile and the event page on a real iPhone in Safari | Portrait grid, no horizontal scroll, the bottom tab bar is reachable, a card opens the profile sheet |

## Afterwards

Check the Railway logs for stack traces during the session, and confirm the version in the principal's office matches the commit you deployed.
