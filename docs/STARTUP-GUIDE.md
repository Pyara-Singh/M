# LesGoMeet — Startup & Usage Guide

LesGoMeet is a Meet-inspired, small-room video conferencing app. It uses browser WebRTC for video/audio and a Cloudflare Worker for secure room signalling.

## What you need

- Node.js 20 or newer
- A modern browser (Chrome, Edge, Firefox, or Safari)
- A Cloudflare account only when you are ready to deploy

## Run locally

Open PowerShell in the `LesGoMeet` folder:

```powershell
cd C:\Users\singh\Documents\pyara\projects\lesgomeet\LesGoMeet
npm install
npm run dev
```

Wrangler prints a local URL, normally `http://localhost:8787`. Open that URL in your browser.

## Start a meeting

1. Enter your name.
2. Enter a meeting code such as `team-demo`.
3. Optionally select your camera and microphone.
4. Select **Join now** and allow browser access to your camera and microphone.
5. Select **Copy joining info** and send the link to another participant.

Everyone joining with the same meeting code enters the same call. The app works best with 2–4 participants.

## Test the real-time features

To test locally, open the same room link in a second browser profile, incognito window, or another device on your network.

- **Mute / Camera**: control local microphone and camera tracks.
- **Present**: select a browser tab, application window, or screen to share. Choose **Stop sharing** when finished.
- **Raise hand**: shows a hand indicator to meeting participants.
- **People & chat**: opens the participant list and the real-time room chat.
- **Reaction buttons**: send visible meeting reactions.
- **Pin**: hover a video tile and select the pin icon to highlight it.

## Deploy for free with Cloudflare

1. Create a free account at [Cloudflare](https://dash.cloudflare.com/sign-up).
2. From the `LesGoMeet` folder, run:

   ```powershell
   npm run deploy
   ```

3. Complete the Cloudflare login when prompted.
4. Wrangler prints a public `workers.dev` address. Open it, create a room, and share its link.

To publish a later update, run `npm run deploy` again.

## Project structure

| Location | Purpose |
| --- | --- |
| `apps/web/index.html` | Meeting and pre-join interface |
| `apps/web/app-showcase.js` | WebRTC calls and all in-call interactions |
| `apps/web/style-showcase.css` | Responsive Meet-inspired design |
| `apps/signaling/src/index.js` | Cloudflare Worker + Durable Object signaling server |
| `services/mediasoup-sfu` | Preserved MediaSoup SFU prototype |
| `wrangler.jsonc` | Cloudflare deployment configuration |

## Important limitations

This is a peer-to-peer WebRTC project, so each user sends media directly to every other user. It is excellent for a portfolio, demos, interviews, and small groups. It is not intended for large meetings or restrictive corporate networks; those need a TURN service and a production SFU such as LiveKit or MediaSoup.

## If “Join now” does not work

- Start the app from the **`LesGoMeet` folder** using `npm run dev`. Do not run a separate Vite server: it does not start the Cloudflare signaling Worker.
- Allow camera and microphone access in the browser permission prompt.
- Use `http://127.0.0.1:8788` (the Wrangler URL) locally, or your deployed Cloudflare `workers.dev` URL. Do not use an old Netlify deployment, because it has no `/signal` WebSocket endpoint.
- After code changes, stop the dev server with `Ctrl+C`, then run `npm run dev` again and refresh the page.
