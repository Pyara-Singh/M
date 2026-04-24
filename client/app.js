import * as mediasoupClient from "mediasoup-client";
import { io } from "socket.io-client";

// ======================
// CONFIG
// ======================
const SFU_URL = import.meta.env.VITE_SFU_URL || "http://localhost:3001";
const GO_URL = import.meta.env.VITE_GO_URL || "http://localhost:8080";

// ======================
// STATE
// ======================
const socket = io(SFU_URL, { reconnectionAttempts: 5 });

let device;
let producerTransport = null;
let consumerTransport = null;
let localStream = null;
let audioProducer = null;
let videoProducer = null;

let audioMuted = false;
let videoOff   = false;

const peerTiles = {};
const producerToPeer = {};
const consumedProducers = new Set();

// ======================
// ROOM INIT
// ======================
const params = new URLSearchParams(window.location.search);
let roomId = params.get("room");
const displayName = `User-${Math.floor(Math.random() * 9000 + 1000)}`;

(async () => {
  if (!roomId) {
    try {
      const data = await fetch(`${GO_URL}/create-room`).then(r => r.json());
      roomId = data.id;
      window.history.replaceState({}, "", `/?room=${roomId}`);
    } catch {
      roomId = `room-${Date.now()}`;
      window.history.replaceState({}, "", `/?room=${roomId}`);
    }
  }
  document.title = `Room: ${roomId}`;
  const roomLabel = document.getElementById("room-label");
  if (roomLabel) roomLabel.textContent = `Room: ${roomId}`;
  start();
})();

// ======================
// UI MANAGEMENT
// ======================
function createTile(peerId, name, isLocal = false) {
  if (peerTiles[peerId]) return peerTiles[peerId];

  const wrapper = document.createElement("div");
  wrapper.className = "tile";
  wrapper.id = `tile-${peerId}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

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

  peerTiles[peerId] = { wrapper, video, stream: new MediaStream(), muteIcon, camIcon };
  video.srcObject = peerTiles[peerId].stream;

  updateGridLayout();
  return peerTiles[peerId];
}

function removeTile(peerId) {
  if (peerTiles[peerId]) {
    peerTiles[peerId].wrapper.remove();
    delete peerTiles[peerId];
    updateGridLayout();
  }
}

function updateGridLayout() {
  const count = Object.keys(peerTiles).length;
  const grid = document.getElementById("video-grid");
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

function setTileMute(peerId, muted) {
  peerTiles[peerId]?.muteIcon.classList.toggle("hidden", !muted);
}

function setTileVideoOff(peerId, off) {
  const tile = peerTiles[peerId];
  if (!tile) return;
  tile.camIcon.classList.toggle("hidden", !off);
  tile.video.classList.toggle("video-off", off);
}

// ======================
// CORE LOGIC
// ======================
async function start() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const tile = createTile("local", displayName, true);
    localStream.getTracks().forEach(t => tile.stream.addTrack(t));
    
    await joinAndPublish();
  } catch (err) {
    console.error("Start failed:", err);
  }
}

async function joinAndPublish() {
  const data = await socketCall("joinRoom", { roomId, displayName });
  if (data.error) return console.error(data.error);

  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: data.rtpCapabilities });

  await createSendTransport();
  await createRecvTransport();
  await publishLocalTracks();

  // Sync initial state
  socket.emit("toggleAudio", { muted: audioMuted });
  socket.emit("toggleVideo", { videoOff: videoOff });

  // Handle existing media
  data.existingPeers.forEach(p => {
    createTile(p.id, p.displayName);
    setTileMute(p.id, p.audioMuted);
    setTileVideoOff(p.id, p.videoOff);
  });

  for (const p of data.existingProducers) {
    producerToPeer[p.producerId] = p.peerId;
    await consume(p.producerId);
  }
}

async function createSendTransport() {
  if (producerTransport) return;
  const p = await socketCall("createTransport", { direction: "send" });
  producerTransport = device.createSendTransport(p);

  producerTransport.on("connect", ({ dtlsParameters }, cb, err) => {
    socketCall("connectTransport", { transportId: p.id, dtlsParameters }).then(cb).catch(err);
  });

  producerTransport.on("produce", ({ kind, rtpParameters, appData }, cb, err) => {
    socketCall("produce", { transportId: p.id, kind, rtpParameters, appData })
      .then(({ id }) => cb({ id })).catch(err);
  });
}

async function createRecvTransport() {
  if (consumerTransport) return;
  const p = await socketCall("createTransport", { direction: "recv" });
  consumerTransport = device.createRecvTransport(p);

  consumerTransport.on("connect", ({ dtlsParameters }, cb, err) => {
    socketCall("connectTransport", { transportId: p.id, dtlsParameters }).then(cb).catch(err);
  });
}

async function publishLocalTracks() {
  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = localStream.getVideoTracks()[0];

  if (audioTrack) {
    audioProducer = await producerTransport.produce({ track: audioTrack, appData: { kind: "audio" } });
  }
  if (videoTrack) {
    videoProducer = await producerTransport.produce({
      track: videoTrack,
      encodings: [{ maxBitrate: 900000 }],
      appData: { kind: "video" }
    });
  }
}

async function consume(producerId) {
  if (consumedProducers.has(producerId) || !consumerTransport) return;
  consumedProducers.add(producerId);

  const data = await socketCall("consume", {
    producerId,
    rtpCapabilities: device.rtpCapabilities,
    transportId: consumerTransport.id
  });

  const consumer = await consumerTransport.consume(data);
  const peerId = producerToPeer[producerId];
  
  if (peerTiles[peerId]) {
    peerTiles[peerId].stream.addTrack(consumer.track);
  }

  consumer.on("trackended", () => consumedProducers.delete(producerId));
  consumer.on("transportclose", () => consumedProducers.delete(producerId));
  
  socket.emit("resumeConsumer", { consumerId: consumer.id });
}

// ======================
// CONTROLS & EVENTS
// ======================
window.toggleMute = async () => {
  audioMuted = !audioMuted;
  audioProducer ? (audioMuted ? audioProducer.pause() : audioProducer.resume()) : null;
  localStream.getAudioTracks().forEach(t => t.enabled = !audioMuted);
  socket.emit("toggleAudio", { muted: audioMuted });
  setTileMute("local", audioMuted);
  document.getElementById("btn-mute").textContent = audioMuted ? "🔇 Unmute" : "🎤 Mute";
};

window.toggleCam = async () => {
  videoOff = !videoOff;
  videoProducer ? (videoOff ? videoProducer.pause() : videoProducer.resume()) : null;
  localStream.getVideoTracks().forEach(t => t.enabled = !videoOff);
  socket.emit("toggleVideo", { videoOff });
  setTileVideoOff("local", videoOff);
  document.getElementById("btn-cam").textContent = videoOff ? "📵 Start Cam" : "📷 Stop Cam";
};

socket.on("newProducer", async ({ producerId, peerId }) => {
  producerToPeer[producerId] = peerId;
  await consume(producerId);
});

socket.on("peerJoined", (p) => createTile(p.id, p.displayName));
socket.on("peerLeft", ({ peerId }) => removeTile(peerId));
socket.on("peerAudioToggled", ({ peerId, muted }) => setTileMute(peerId, muted));
socket.on("peerVideoToggled", ({ peerId, videoOff }) => setTileVideoOff(peerId, videoOff));

socket.on("reconnect", async () => {
  if (producerTransport) producerTransport.close();
  if (consumerTransport) consumerTransport.close();
  producerTransport = null;
  consumerTransport = null;
  consumedProducers.clear();
  Object.keys(peerTiles).forEach(id => id !== "local" && removeTile(id));
  await joinAndPublish();
});

function socketCall(event, data = {}) {
  return new Promise((res) => socket.emit(event, data, res));
}