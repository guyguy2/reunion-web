# Reunion Web

Class reunion website (Hadassim, class of '96). Proof of concept. The interface is in Hebrew and laid out right-to-left.

The centerpiece is a zoomable "yearbook": the class composite posters from 1990, 1993 and 1996 as deep-zoom pictures with a clickable box on every face. Classmates find themselves, put a name on a face ("That's me!" or "I know who this is"), claim their profile and fill in what they have been up to. Around it: a 90s cassette-deck mixtape (YouTube playlist), embedded videos, a link to the shared Google Photos album, and event details.

## Features

- **Passcode gate.** One shared class passcode, checked on the server. Nothing (API, pictures, uploads) is served without it. A separate admin passcode unlocks the organizer tools. Every response is `noindex`.
- **Yearbook viewer.** OpenSeadragon deep zoom, one tab per picture, search that flies to a person, deep link per person (`/p/:id`), "through the years" strip cropped from each poster, then/now slider.
- **Crowd-sourced names.** Unnamed faces can be named by any classmate. Claiming a profile returns a private edit link; only its hash is stored. Organizers can reset a claim.
- **Admin ("Principal's Office").** Upload pictures (auto-tiled), auto-detect faces in the browser (MediaPipe), draw/move/delete boxes (Annotorious), assign names, add people, CSV roster import, rebuild the generated portrait wall, load demo data, wipe.
- **Mixtape.** Persistent YouTube playlist player dressed as a cassette; it keeps playing across pages and pauses when a video starts.
- **Videos, Memories, Event** pages driven by `content/event.json`.

## Stack

Node 24, Hono, SQLite (`node:sqlite`) and sharp on the server. React, Vite, Tailwind v4 on the client. One process serves the API, the gated media and the built SPA. All state lives in `DATA_DIR` (database, image tiles, uploads), which is a volume in production.

## Local development

```sh
pnpm install
cp .env.example .env    # then set the passcodes and a random SESSION_SECRET
pnpm dev                # API on :3000, Vite on :5173 (or the next free port)
pnpm seed               # optional: fake classmates and pictures into an empty ./data
pnpm test
pnpm typecheck
```

Real class photos are uploaded through the admin page and stored in `DATA_DIR`. They are never committed.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CLASS_PASSCODE` | Shared passcode for classmates |
| `ADMIN_PASSCODE` | Organizer passcode |
| `SESSION_SECRET` | Signs the session cookie. Long and random |
| `DATA_DIR` | Where the database, tiles and uploads live (`/data` in production) |
| `GOOGLE_PHOTOS_ALBUM_URL` | Shared album link. Kept out of git because the link itself grants access |
| `YOUTUBE_PLAYLIST_ID` | Optional override for `music.youtubePlaylistId` in `content/event.json` |

Event details, schedule, the mixtape playlist and the video list are in `content/event.json`.

## Deployment (Railway)

Built from the `Dockerfile`. One service with a volume mounted at `/data`, the variables above, and a health check on `/healthz`.

```sh
railway init
railway volume add --mount-path /data
railway variable set CLASS_PASSCODE=... ADMIN_PASSCODE=... SESSION_SECRET=... GOOGLE_PHOTOS_ALBUM_URL=...
railway up
railway domain
```
