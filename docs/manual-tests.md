# Manual tests after a deploy

What to click through on the live site after `pnpm release`. The automated suite (`pnpm typecheck && pnpm test`) covers the server routes end to end on a temporary database, and the client only through pure helpers, so the browser checks below matter most for anything in `web/`.

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
| Passcode change | Change the class passcode in admin, reload the site in another browser | That browser asks for the new passcode |
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
| Scene viewer | Open a scene deep link in a fresh tab, then use the arrow keys over faces | Loads, keyboard moves between faces, back does not bounce |
| Tapes | Play a Spotify tape and let it end | The next tape starts; with the network blocked, a message instead of a blank player |
| Contact links | Save an email with a typo like `a@b` | Rejected on the client and on the server |
| Notes | Send a note while offline | Error shown, the note can be resent |
| Profile draft | Fill in half the profile form, reload | The draft is still there |
| Phone | Open the yearbook on a phone | Portrait grid, no horizontal scroll |

## Afterwards

Check the Railway logs for stack traces during the session, and confirm the version in the principal's office matches the commit you deployed.
