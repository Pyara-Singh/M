# LesGoMeet

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
