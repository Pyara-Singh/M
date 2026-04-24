# Deployment Readiness Guide

This repository contains three services:

- `client/` — Vite-based browser app
- `server/` — Go API gateway for room creation
- `sfu/` — mediasoup SFU for WebRTC media relay

## What changed

- `client/app.js` now reads deploy-time URLs from Vite environment variables:
  - `VITE_SFU_URL`
  - `VITE_GO_URL`
- `client/package.json` now includes build and preview scripts.
- `client/.env` provides local development defaults.
- `client/.env.production` provides a production override template.
- `sfu/package.json` now includes a `start` script.

## Local development

1. Install dependencies:
   - `cd client && npm install`
   - `cd ../sfu && npm install`
   - `cd ../server && go mod download`

2. Run services:
   - `cd client && npm run dev`
   - `cd ../sfu && npm start`
   - `cd ../server && go run main.go`

3. Open the client in your browser, e.g. `http://localhost:5173`.

## Production deployment

### Client

1. Build the client:
   - `cd client && npm run build`
2. Deploy the generated `dist/` folder to any static site host.
3. Set production values in `client/.env.production` or via build-time environment variables.

### SFU

1. Configure the public host/IP:
   - `export ANNOUNCED_IP=YOUR_PUBLIC_IP_OR_HOSTNAME`
2. Start the SFU:
   - `cd sfu && npm start`
3. Ensure these ports are reachable from the public internet:
   - `3001` for socket.io signaling
   - `40000-49999` for mediasoup RTP/RTCP

### Go API

1. Run the API server on port `8080`:
   - `cd server && go run main.go`
2. If you want this service behind a reverse proxy, route external traffic to `localhost:8080`.

## Environment variables

- `VITE_SFU_URL` — URL for the SFU signaling server
- `VITE_GO_URL` — URL for the Go room API
- `ANNOUNCED_IP` — public IP/hostname for mediasoup SFU

## Notes

- The client still defaults to `http://localhost:3001` and `http://localhost:8080` when no env values are provided.
- This keeps the existing working behavior while enabling deploy-time configuration.
- The in-memory room store in `server/main.go` is okay for single-instance use but not for multi-instance scaling.

## Docker deployment

### Build and run with Docker Compose

From `M/`:

```bash
docker compose up --build
```

Then open the client at `http://localhost:8082`.

### What the services expose

- `client`: `http://localhost:8082`
- `api`: `http://localhost:8080`
- `sfu`: `http://localhost:3001`

### Local Docker Compose notes

- The client image is built with `VITE_SFU_URL=http://localhost:3001` and `VITE_GO_URL=http://localhost:8080`.
- The SFU service uses `ANNOUNCED_IP=host.docker.internal` for local Docker Desktop on Windows.
- If you deploy to a real server, replace `ANNOUNCED_IP` with your public IP or hostname.

## Netlify deployment

The frontend can be deployed to Netlify, but the backend services must run separately on another host.

1. Connect your repo to Netlify.
2. In Site settings, set:
   - Base directory: `M/client`
   - Build command: `npm run build`
   - Publish directory: `dist`
3. Set environment variables in Netlify:
   - `VITE_SFU_URL`
   - `VITE_GO_URL`
4. Deploy the site.

### Important

- Netlify can host `client/` as a static site only.
- `server/` and `sfu/` cannot run on Netlify because they are long-lived backend services.
- Host the Go API and mediasoup SFU elsewhere, then point `VITE_GO_URL` and `VITE_SFU_URL` at those external URLs.

## Remote backend hosting

For remote backend hosting, use the service containers or direct binaries on separate hosts.

### Example public host setup

- `server` on `https://api.example.com`
- `sfu` on `https://sfu.example.com`

Then set Netlify env vars:

- `VITE_GO_URL=https://api.example.com`
- `VITE_SFU_URL=https://sfu.example.com`

### Notes

- `server/` and `sfu/` are already deployable with Docker via their Dockerfiles.
- `sfu` must have `ANNOUNCED_IP` set to its public IP or hostname.
- Open `3001` for signaling and `40000-49999` for mediasoup media traffic.

For full remote backend details, see `M/REMOTE-DEPLOYMENT.md`.

## Free setup recommendation

If you want a 100% free setup, use:

- Frontend: Netlify free
- Backend: Oracle Cloud Always Free compute instance

This is the easiest free route that supports the SFU's UDP port requirements. See `M/FREE-DEPLOYMENT.md` for the exact steps.
