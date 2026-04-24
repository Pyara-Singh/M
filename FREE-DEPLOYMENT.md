# Free Deployment Guide

This project can be deployed with free services for the frontend and an always-free cloud VM for the backend.

## 1. Frontend: Netlify (free)

- Connect your repo to Netlify.
- Set the base directory to `M/client`.
- Build command: `npm run build`
- Publish directory: `dist`
- Add these env vars on Netlify:
  - `VITE_GO_URL` = your public API URL
  - `VITE_SFU_URL` = your public SFU URL

Netlify is completely free for this static frontend.

## 2. Backend: Oracle Cloud Free Tier (100% free)

The SFU requires UDP support, so the best fully free option is Oracle Cloud Always Free Compute.

### Steps

1. Sign up for Oracle Cloud Free Tier.
2. Create an "Always Free" VM instance.
   - Choose an Ubuntu or Debian image.
   - Choose the free Ampere A1 or VM.Standard.E2.1.Micro shape.
3. Reserve a public IP address for the VM.
4. In the VM's networking/security rules, allow:
   - TCP 8080
   - TCP 3001
   - UDP 40000-49999
   - TCP 40000-49999
5. SSH into the VM.
6. Install Docker (or use the OS-native runtime).

### Deploy `server/`

- Copy `M/server` to the VM.
- Build and run it with Docker or `go run main.go`.
- Example using Docker:
  ```bash
  cd server
  docker build -t lesgomeet_api .
  docker run -d --name lesgomeet_api -p 8080:8080 lesgomeet_api
  ```

### Deploy `sfu/`

- Copy `M/sfu` to the VM.
- Build and run it with Docker or `node server.js`.
- Use `ANNOUNCED_IP` set to the VM's public IP.
- Example using Docker:
  ```bash
  cd sfu
  docker build -t lesgomeet_sfu .
  docker run -d --name lesgomeet_sfu \
    -p 3001:3001 \
    -p 40000-49999:40000-49999/udp \
    -p 40000-49999:40000-49999/tcp \
    -e ANNOUNCED_IP=<PUBLIC_IP> \
    lesgomeet_sfu
  ```

## 3. Connect Netlify to your backends

- `VITE_GO_URL=https://<your-api-host>`
- `VITE_SFU_URL=https://<your-sfu-host>`

If the API and SFU are on the same VM, you can use the same host with different ports and proxy rules.

## Notes

- This is the easiest truly free setup that supports mediasoup.
- If you want a simpler but non-free option, you can use a paid VPS or cloud service instead.
- Netlify cannot host the backend services.
