# LesGoMeet

<<<<<<< HEAD
A polished, account-free peer-to-peer video calling app. Cloudflare Workers hosts the site and provides WebSocket room signalling; video and audio travel directly between participants.

## Portfolio features

- Meet-inspired pre-join flow with device selection
- Shareable meeting links and real-time room presence
- WebRTC HD camera and microphone calls
- Screen sharing with track replacement and automatic restore
- In-call chat, reactions, raise hand, pinning, and participant list
- Responsive meeting layout and clear connection states
- Serverless Cloudflare signaling through a Durable Object

## Deploy free on Cloudflare

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. In this directory, run `npm install` once, then run `npm run deploy`.
3. Log into Cloudflare when prompted. Wrangler prints the public `workers.dev` URL.

For local development, run `npm run dev` and open the URL it prints. Test a call in two separate browser windows, with a different room name for each test.

## Important limitation

This is intentionally peer-to-peer, so it is ideal for small rooms (roughly 2–4 people). It uses free public STUN servers; a small number of restrictive corporate or mobile networks can require a TURN relay. Add a TURN service before relying on it for business-critical calls or larger rooms.

The former `server` and `sfu` directories are preserved only as the previous MediaSoup implementation; they are not used by this deployment.
=======
A scalable WebRTC video conferencing platform built using Mediasoup SFU architecture.

## Tech Stack

- Frontend: Vite + Vanilla JS
- Backend API: Golang
- SFU: Node.js + Mediasoup
- Signaling: Socket.io
- WebRTC for realtime media

## Architecture

- Frontend communicates with Go API for room management
- Frontend connects to Mediasoup SFU using Socket.io
- SFU manages WebRTC transports, producers, and consumers

## Features

- Multi-user video conferencing
- Real-time audio/video
- Room creation and joining
- SFU-based scalable architecture
- WebRTC signaling

## Structure

```txt
client/
server/
sfu/
```
>>>>>>> 856feb6dd868c511fcd252e91a98db9ed2fa036a
