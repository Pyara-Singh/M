# Remote Backend Hosting

This project now supports remote backend hosting for `server/` and `sfu/`, while the frontend remains hosted on Netlify.

## Goal

- Host `client/` as a static site on Netlify
- Host `server/` and `sfu/` on separate public servers or services
- Configure `client` to call the public API and SFU URLs

## Recommended pattern

1. Deploy `server/` to one public host:
   - Example API URL: `https://api.example.com`
   - This service runs on port `8080` internally
2. Deploy `sfu/` to another public host:
   - Example SFU URL: `https://sfu.example.com`
   - This service runs on port `3001` for signaling
   - Must also open `40000-49999` for WebRTC media traffic
3. Point the Netlify frontend to those URLs:
   - `VITE_GO_URL=https://api.example.com`
   - `VITE_SFU_URL=https://sfu.example.com`

## How to deploy the backends

### Option A: VPS or cloud VM

1. Build the service container on the host or push it to a registry.
2. Run `server` with Docker or directly:
   - `cd server && go run main.go`
3. Run `sfu` with Docker or Node:
   - `cd sfu && npm install && npm start`
4. Set `ANNOUNCED_IP` to the public address of the host running `sfu`.

### Option B: Docker on a remote host

1. Copy the folder to the remote host.
2. Run `docker build` in `server/` and `sfu/`.
3. Start containers:
   - `docker run -d --name lesgomeet_api -p 8080:8080 server`
   - `docker run -d --name lesgomeet_sfu -p 3001:3001 -p 40000-49999:40000-49999/udp -p 40000-49999:40000-49999/tcp -e ANNOUNCED_IP=<public-ip> sfu`

### Important SFU networking notes

- `ANNOUNCED_IP` must be the public IP or hostname of the SFU host.
- Open UDP/TCP ports `40000-49999`.
- Ensure the domain for `sfu` has a valid certificate if using HTTPS.

## Client configuration

- In Netlify environment settings, set:
  - `VITE_GO_URL=https://api.example.com`
  - `VITE_SFU_URL=https://sfu.example.com`

## Notes

- The Go API already allows CORS from any origin for `GET`/`POST`/`OPTIONS`.
- The SFU socket server already allows CORS from any origin.
- The frontend uses environment variables so no code changes are needed for remote hosts.
