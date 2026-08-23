import * as mediasoupClient from "mediasoup-client";
import { io } from "socket.io-client";

// ======================
// CONFIG
// ======================
// URLs for the SFU (Media Server) and the Go API Gateway.
// Defaults are provided for production, but environment variables can override them.
const SFU_URL = import.meta.env.VITE_SFU_URL || "https://m2-f668.onrender.com";
const GO_URL = import.meta.env.VITE_GO_URL || "https://go7273h.netlify.app";

// ======================
// STATE
// ======================
// The socket connection to the SFU server for signaling.
const socket = io(SFU_URL, { reconnectionAttempts: 5 });

let device;               // mediasoup-client Device: container for all local media handling.
let producerTransport = null; // Transport for sending media (Local -> Server).
let consumerTransport = null; // Transport for receiving media (Server -> Local).
let localStream = null;       // Local camera/mic stream.
let audioProducer = null;     // Mediasoup producer for the local audio track.
let videoProducer = null;     // Mediasoup producer for the local video track.

let audioMuted = false;       // Local mute state tracking.
let videoOff = false;         // Local camera state tracking.

const peerTiles = {};         // Map of peerId -> { UI elements, MediaStream } for rendering.
const producerToPeer = {};    // Map of producerId -> peerId to track who owns which stream.
const consumedProducers = new Set(); // Set of producers we are already consuming to avoid duplicates.

// ======================
// ROOM INIT
// ======================
// Extracts the 'room' ID from the URL or requests a new one from the Go API.
const params = new URLSearchParams(window.location.search);
let roomId = params.get("room");
const displayName = `User-${Math.floor(Math.random() * 9000 + 1000)}`;

(async () => {
  // If no room ID is in the URL, fetch one from the Go backend.
  if (!roomId) {
    try {
      const data = await fetch(`${GO_URL}/create-room`).then(r => r.json());
      roomId = data.id;
      // Update URL without reloading the page.
      window.history.replaceState({}, "", `/?room=${roomId}`);
    } catch {
      // Fallback if the Go server is down.
      roomId = `room-${Date.now()}`;
      window.history.replaceState({}, "", `/?room=${roomId}`);
    }
  }
  document.title = `Room: ${roomId}`;
  const roomLabel = document.getElementById("room-label");
  if (roomLabel) roomLabel.textContent = `Room: ${roomId}`;
  
  // Start the media initialization process.
  start();
})();

// ======================
// UI MANAGEMENT
// ======================

/**
 * Creates a video tile in the DOM for a specific peer.
 * @param {string} peerId - Unique ID for the peer (or "local").
 * @param {string} name - Display name for the peer.
 * @param {boolean} isLocal - Whether this is the local user's tile.
 */
function createTile(peerId, name, isLocal = false) {
  if (peerTiles[peerId]) return peerTiles[peerId];

  const wrapper = document.createElement("div");
  wrapper.className = "tile";
  wrapper.id = `tile-${peerId}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true; // Don't hear your own echo.

  const label = document.createElement("div");
  label.className = "tile-label";
  label.textContent = isLocal ? `${name} (You)` : name;

  const muteIcon = document.createElement("div");
  muteIcon.className = "tile-icon mute-icon hidden";
  muteIcon.textContent = "🔇";

  const camIcon = document.createElement("div");
  camIcon.className = "tile-icon cam-icon hidden";
  camIcon.textContent = "📵";

  wrapper.append(video, label, muteIcon, camIcon);
  document.getElementById("video-grid").appendChild(wrapper);

  // Store references for later manipulation (e.g., adding tracks or updating icons).
  peerTiles[peerId] = { wrapper, video, stream: new MediaStream(), muteIcon, camIcon };
  video.srcObject = peerTiles[peerId].stream;

  updateGridLayout();
  return peerTiles[peerId];
}

/**
 * Removes a peer's tile from the DOM and state.
 */
function removeTile(peerId) {
  if (peerTiles[peerId]) {
    peerTiles[peerId].wrapper.remove();
    delete peerTiles[peerId];
    updateGridLayout();
  }
}

/**
 * Dynamically adjusts the CSS grid columns based on the number of active tiles.
 */
function updateGridLayout() {
  const count = Object.keys(peerTiles).length;
  const grid = document.getElementById("video-grid");
  // Simple logic: 1 col for 1 user, 2 cols for 2-4 users, etc.
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

/**
 * Toggles the visibility of the mute icon on a specific tile.
 */
function setTileMute(peerId, muted) {
  peerTiles[peerId]?.muteIcon.classList.toggle("hidden", !muted);
}

/**
 * Toggles the visibility of the camera-off icon and applies a visual filter to the video element.
 */
function setTileVideoOff(peerId, off) {
  const tile = peerTiles[peerId];
  if (!tile) return;
  tile.camIcon.classList.toggle("hidden", !off);
  tile.video.classList.toggle("video-off", off);
}

// ======================
// CORE LOGIC
// ======================

/**
 * Initial entry point: captures local media and starts the connection process.
 */
async function start() {
  try {
    // 1. Get access to camera and microphone.
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    
    // 2. Create the local tile and attach the local stream.
    const tile = createTile("local", displayName, true);
    localStream.getTracks().forEach(t => tile.stream.addTrack(t));

    // 3. Connect to the SFU and publish our tracks.
    await joinAndPublish();
  } catch (err) {
    console.error("Start failed (likely camera permission denied):", err);
  }
}

/**
 * Joins the room via socket and initializes the Mediasoup device and transports.
 */
async function joinAndPublish() {
  // 1. Tell the SFU we want to join. It returns RTP capabilities (what codecs it supports).
  const data = await socketCall("joinRoom", { roomId, displayName });
  if (data.error) return console.error(data.error);

  // 2. Initialize the Mediasoup Device. This acts as a gateway for WebRTC on the client.
  device = new mediasoupClient.Device();
  // Load the device with the router's capabilities to ensure compatibility.
  await device.load({ routerRtpCapabilities: data.rtpCapabilities });

  // 3. Create transports for sending (Publishing) and receiving (Consuming).
  await createSendTransport();
  await createRecvTransport();
  
  // 4. Start sending our local audio and video.
  await publishLocalTracks();

  // 5. Tell the SFU our initial mute/cam status.
  socket.emit("toggleAudio", { muted: audioMuted });
  socket.emit("toggleVideo", { videoOff: videoOff });

  // 6. Handle peers that were already in the room when we joined.
  data.existingPeers.forEach(p => {
    createTile(p.id, p.displayName);
    setTileMute(p.id, p.audioMuted);
    setTileVideoOff(p.id, p.videoOff);
  });

  // 7. Start consuming media from existing participants.
  for (const p of data.existingProducers) {
    producerToPeer[p.producerId] = p.peerId;
    await consume(p.producerId);
  }
}

/**
 * Creates a WebRTC transport for sending media to the server.
 */
async function createSendTransport() {
  if (producerTransport) return;
  
  // Request transport parameters from the SFU.
  const p = await socketCall("createTransport", { direction: "send" });
  
  // Create the local side of the transport.
  producerTransport = device.createSendTransport(p);

  // Event: Mediasoup needs to connect the local transport to the server-side transport.
  producerTransport.on("connect", ({ dtlsParameters }, cb, err) => {
    socketCall("connectTransport", { transportId: p.id, dtlsParameters }).then(cb).catch(err);
  });

  // Event: Triggered when we start 'producing' a track (sending it to the server).
  producerTransport.on("produce", ({ kind, rtpParameters, appData }, cb, err) => {
    socketCall("produce", { transportId: p.id, kind, rtpParameters, appData })
      .then(({ id }) => cb({ id })).catch(err);
  });
}

/**
 * Creates a WebRTC transport for receiving media from the server.
 */
async function createRecvTransport() {
  if (consumerTransport) return;
  
  // Request transport parameters from the SFU.
  const p = await socketCall("createTransport", { direction: "recv" });
  
  // Create the local side of the transport.
  consumerTransport = device.createRecvTransport(p);

  // Event: Connect the local transport to the server side.
  consumerTransport.on("connect", ({ dtlsParameters }, cb, err) => {
    socketCall("connectTransport", { transportId: p.id, dtlsParameters }).then(cb).catch(err);
  });
}

/**
 * Takes the local MediaStream tracks and creates Mediasoup Producers for them.
 */
async function publishLocalTracks() {
  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = localStream.getVideoTracks()[0];

  if (audioTrack) {
    // Create a producer for audio.
    audioProducer = await producerTransport.produce({ track: audioTrack, appData: { kind: "audio" } });
  }
  if (videoTrack) {
    // Create a producer for video with a defined maximum bitrate.
    videoProducer = await producerTransport.produce({
      track: videoTrack,
      encodings: [{ maxBitrate: 900000 }],
      appData: { kind: "video" }
    });
  }
}

/**
 * Starts receiving a specific producer's media stream from the server.
 * @param {string} producerId - The ID of the track we want to receive.
 */
async function consume(producerId) {
  // Avoid duplicate consumers or consuming before the transport is ready.
  if (consumedProducers.has(producerId) || !consumerTransport) return;
  consumedProducers.add(producerId);

  // 1. Request the server to create a 'Consumer' for this producer.
  const data = await socketCall("consume", {
    producerId,
    rtpCapabilities: device.rtpCapabilities,
    transportId: consumerTransport.id
  });

  // 2. Create the local side of the consumer using the parameters from the server.
  const consumer = await consumerTransport.consume(data);
  const peerId = producerToPeer[producerId];

  // 3. Attach the new track to the correct peer's video tile.
  if (peerTiles[peerId]) {
    peerTiles[peerId].stream.addTrack(consumer.track);
  }

  // Cleanup if the track or transport ends.
  consumer.on("trackended", () => consumedProducers.delete(producerId));
  consumer.on("transportclose", () => consumedProducers.delete(producerId));

  // 4. Mediasoup consumers start in a 'paused' state; we must resume them.
  socket.emit("resumeConsumer", { consumerId: consumer.id });
}

// ======================
// CONTROLS & EVENTS
// ======================

/**
 * Global function (attached to window) to toggle local microphone.
 */
window.toggleMute = async () => {
  audioMuted = !audioMuted;
  // Pause/Resume the producer on the SFU side to save bandwidth.
  audioProducer ? (audioMuted ? audioProducer.pause() : audioProducer.resume()) : null;
  // Disable/Enable the local track for immediate UI feedback.
  localStream.getAudioTracks().forEach(t => t.enabled = !audioMuted);
  // Notify others via signaling.
  socket.emit("toggleAudio", { muted: audioMuted });
  setTileMute("local", audioMuted);
  document.getElementById("btn-mute").textContent = audioMuted ? "🔇 Unmute" : "🎤 Mute";
};

/**
 * Global function (attached to window) to toggle local camera.
 */
window.toggleCam = async () => {
  videoOff = !videoOff;
  videoProducer ? (videoOff ? videoProducer.pause() : videoProducer.resume()) : null;
  localStream.getVideoTracks().forEach(t => t.enabled = !videoOff);
  socket.emit("toggleVideo", { videoOff });
  setTileVideoOff("local", videoOff);
  document.getElementById("btn-cam").textContent = videoOff ? "📵 Start Cam" : "📷 Stop Cam";
};

// Event: A new participant has started sending media.
socket.on("newProducer", async ({ producerId, peerId }) => {
  producerToPeer[producerId] = peerId;
  await consume(producerId);
});

// Event: A new participant has joined the room.
socket.on("peerJoined", (p) => createTile(p.id, p.displayName));

// Event: A participant has left the room.
socket.on("peerLeft", ({ peerId }) => removeTile(peerId));

// Event: Someone else toggled their mute status.
socket.on("peerAudioToggled", ({ peerId, muted }) => setTileMute(peerId, muted));

// Event: Someone else toggled their camera status.
socket.on("peerVideoToggled", ({ peerId, videoOff }) => setTileVideoOff(peerId, videoOff));

// Event: Handle socket reconnection (e.g., internet dropped).
socket.on("reconnect", async () => {
  console.log("Reconnected to SFU. Resyncing state...");
  if (producerTransport) producerTransport.close();
  if (consumerTransport) consumerTransport.close();
  producerTransport = null;
  consumerTransport = null;
  consumedProducers.clear();
  // Clear all remote tiles and rejoin to get fresh state.
  Object.keys(peerTiles).forEach(id => id !== "local" && removeTile(id));
  await joinAndPublish();
});

/**
 * Helper to wrap socket.emit in a Promise for cleaner async/await syntax.
 */
function socketCall(event, data = {}) {
  return new Promise((res) => socket.emit(event, data, res));
}
t, data, res));
}