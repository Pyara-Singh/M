import * as mediasoupClient from "mediasoup-client";
import { io } from "socket.io-client";

const $ = (selector) => document.querySelector(selector);
const SFU_URL = import.meta.env.VITE_SFU_URL || "http://localhost:3001";
const socket = io(SFU_URL, { autoConnect: false, reconnectionAttempts: 5 });
const tiles = new Map();
const peers = new Map();
const producerOwner = new Map();
const consumed = new Set();

let roomId, displayName, localStream, device, sendTransport, recvTransport;
let audioProducer, videoProducer, cameraTrack, sharing = false, muted = false, cameraOff = false, raised = false;

const status = (message, bad = false) => { $("#status").textContent = message; $("#status").classList.toggle("bad", bad); };
const call = (event, payload = {}) => new Promise((resolve, reject) => socket.emit(event, payload, (data = {}) => data.error ? reject(new Error(data.error)) : resolve(data)));

async function loadDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [kind, select] of [["videoinput", $("#camera")], ["audioinput", $("#microphone")]]) {
    select.innerHTML = "";
    select.add(new Option(`Default ${kind === "videoinput" ? "camera" : "microphone"}`, ""));
    devices.filter((item) => item.kind === kind).forEach((item, index) => select.add(new Option(item.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${index + 1}`, item.deviceId)));
  }
}
loadDevices().catch(() => {});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  displayName = $("#name").value.trim();
  roomId = $("#room").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (roomId.length < 3) return status("Use at least 3 letters in the room name.", true);
  try {
    status("Preparing your camera…");
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: $("#camera").value ? { exact: $("#camera").value } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { deviceId: $("#microphone").value ? { exact: $("#microphone").value } : undefined }
    });
    cameraTrack = localStream.getVideoTracks()[0];
    await loadDevices();
    history.replaceState({}, "", `?room=${encodeURIComponent(roomId)}`);
    $("#lobby").classList.add("hidden"); $("#call").classList.remove("hidden"); $("#room-title").textContent = roomId;
    addTile("local", displayName, localStream, true);
    await join();
  } catch (error) { console.error(error); status(error.message || "Allow camera and microphone access to join.", true); }
});

async function join() {
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve); socket.once("connect_error", reject); socket.connect();
  });
  const room = await call("joinRoom", { roomId, displayName });
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: room.rtpCapabilities });
  await createSendTransport(); await createReceiveTransport(); await publishLocalTracks();
  room.existingPeers.forEach((peer) => { peers.set(peer.id, peer); addPlaceholder(peer.id, peer.displayName); });
  for (const producer of room.existingProducers) { producerOwner.set(producer.producerId, producer.peerId); await consume(producer.producerId); }
  status("You’re in the meeting"); updateParticipants();
}

async function createSendTransport() {
  const params = await call("createTransport", { direction: "send" });
  sendTransport = device.createSendTransport(params);
  sendTransport.on("connect", ({ dtlsParameters }, ok, fail) => call("connectTransport", { transportId: params.id, dtlsParameters }).then(ok).catch(fail));
  sendTransport.on("produce", ({ kind, rtpParameters, appData }, ok, fail) => call("produce", { transportId: params.id, kind, rtpParameters, appData }).then(({ id }) => ok({ id })).catch(fail));
}
async function createReceiveTransport() {
  const params = await call("createTransport", { direction: "recv" });
  recvTransport = device.createRecvTransport(params);
  recvTransport.on("connect", ({ dtlsParameters }, ok, fail) => call("connectTransport", { transportId: params.id, dtlsParameters }).then(ok).catch(fail));
}
async function publishLocalTracks() {
  const audio = localStream.getAudioTracks()[0];
  if (audio) audioProducer = await sendTransport.produce({ track: audio, appData: { source: "microphone" } });
  if (cameraTrack) videoProducer = await sendTransport.produce({ track: cameraTrack, encodings: [{ maxBitrate: 900000 }], appData: { source: "camera" } });
}
async function consume(producerId) {
  if (consumed.has(producerId)) return; consumed.add(producerId);
  const data = await call("consume", { producerId, rtpCapabilities: device.rtpCapabilities, transportId: recvTransport.id });
  const consumer = await recvTransport.consume(data);
  const owner = producerOwner.get(producerId); const peer = peers.get(owner);
  if (owner && peer) {
    if (!peer.stream) peer.stream = new MediaStream();
    peer.stream.addTrack(consumer.track); addTile(owner, peer.displayName, peer.stream);
  }
  consumer.on("transportclose", () => consumed.delete(producerId));
  await call("resumeConsumer", { consumerId: consumer.id });
}

function addPlaceholder(id, name) { if (!tiles.has(id)) addTile(id, name, new MediaStream()); }
function addTile(id, name, stream, local = false) {
  let tile = tiles.get(id);
  if (!tile) {
    const element = document.createElement("article"); element.className = "tile"; element.id = `tile-${id}`;
    element.innerHTML = `<video autoplay playsinline ${local ? "muted" : ""}></video><div class="tile-gradient"></div><div class="tile-name"></div><div class="tile-state"></div><button class="pin" title="Pin participant">⌗</button>`;
    element.querySelector(".pin").onclick = (event) => { event.stopPropagation(); document.querySelectorAll(".tile").forEach((item) => item.classList.toggle("pinned", item === element)); };
    $("#video-grid").append(element); tile = { element, stream }; tiles.set(id, tile);
  }
  tile.stream = stream; tile.element.querySelector("video").srcObject = stream; tile.element.querySelector(".tile-name").textContent = `${name}${local ? " (You)" : ""}`;
}
function removePeer(id) { peers.delete(id); tiles.get(id)?.element.remove(); tiles.delete(id); updateParticipants(); }
function updateParticipants() {
  const list = $("#participant-list"); list.innerHTML = "";
  [["local", displayName || "You"], ...Array.from(peers, ([id, peer]) => [id, peer.displayName])].forEach(([id, name]) => {
    const row = document.createElement("li");
    const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = name[0]?.toUpperCase() || "?";
    const label = document.createElement("span"); label.textContent = `${name}${id === "local" ? " (You)" : ""}`;
    row.append(avatar, label); list.append(row);
  }); $("#participant-count").textContent = peers.size + 1;
}
function addChat(name, text, own = false) { const item = document.createElement("article"); item.className = `message ${own ? "self" : ""}`; item.innerHTML = `<b></b><p></p>`; item.querySelector("b").textContent = name; item.querySelector("p").textContent = text; $("#messages").append(item); $("#messages").scrollTop = $("#messages").scrollHeight; }

$("#btn-mute").onclick = async () => { muted = !muted; localStream.getAudioTracks().forEach((track) => track.enabled = !muted); muted ? audioProducer?.pause() : audioProducer?.resume(); socket.emit("toggleAudio", { muted }); $("#btn-mute").classList.toggle("active", muted); $("#btn-mute span").textContent = muted ? "Unmute" : "Mute"; };
$("#btn-cam").onclick = async () => { cameraOff = !cameraOff; cameraTrack.enabled = !cameraOff; cameraOff ? videoProducer?.pause() : videoProducer?.resume(); socket.emit("toggleVideo", { videoOff: cameraOff }); $("#btn-cam").classList.toggle("active", cameraOff); $("#btn-cam span").textContent = cameraOff ? "Camera on" : "Camera"; };
$("#btn-share").onclick = async () => {
  try {
    if (sharing) return stopSharing();
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true }); const track = display.getVideoTracks()[0];
    await videoProducer.replaceTrack({ track }); localStream.removeTrack(cameraTrack); localStream.addTrack(track); tiles.get("local").element.querySelector("video").srcObject = localStream;
    sharing = true; $("#btn-share").classList.add("active"); $("#btn-share span").textContent = "Stop sharing"; track.onended = stopSharing;
  } catch (error) { console.error(error); }
};
async function stopSharing() { if (!sharing) return; await videoProducer.replaceTrack({ track: cameraTrack }); localStream.getVideoTracks().forEach((track) => { localStream.removeTrack(track); track.stop(); }); localStream.addTrack(cameraTrack); tiles.get("local").element.querySelector("video").srcObject = localStream; sharing = false; $("#btn-share").classList.remove("active"); $("#btn-share span").textContent = "Present"; }
$("#btn-hand").onclick = () => { raised = !raised; socket.emit("raiseHand", { raised }); $("#btn-hand").classList.toggle("active", raised); };
$("#chat-form").onsubmit = (event) => { event.preventDefault(); const input = $("#chat-input"); const text = input.value.trim(); if (text) { socket.emit("chatMessage", { text }); addChat(displayName, text, true); input.value = ""; } };
$("#reactions").onclick = (event) => { if (event.target.matches("button")) socket.emit("reaction", { value: event.target.textContent }); };
$("#copy-link").onclick = async () => { await navigator.clipboard.writeText(location.href); $("#copy-link").textContent = "Link copied"; setTimeout(() => $("#copy-link").textContent = "Copy joining info", 1500); };
$("#btn-leave").onclick = () => { socket.disconnect(); localStream?.getTracks().forEach((track) => track.stop()); location.href = location.pathname; };
document.querySelectorAll("[data-panel]").forEach((button) => button.onclick = () => $("#sidepanel").classList.remove("hidden"));

socket.on("newProducer", async ({ producerId, peerId }) => { producerOwner.set(producerId, peerId); await consume(producerId); });
socket.on("peerJoined", (peer) => { peers.set(peer.id, peer); addPlaceholder(peer.id, peer.displayName); updateParticipants(); });
socket.on("peerLeft", ({ peerId }) => removePeer(peerId));
socket.on("chatMessage", ({ displayName, text }) => addChat(displayName, text));
socket.on("reaction", ({ value }) => { const reaction = document.createElement("div"); reaction.className = "reaction"; reaction.textContent = value; document.body.append(reaction); setTimeout(() => reaction.remove(), 1800); });
socket.on("peerHandRaised", ({ peerId, raised }) => { const tile = tiles.get(peerId); if (tile) tile.element.querySelector(".tile-state").textContent = raised ? "✋" : ""; });
