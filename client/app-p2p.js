const $ = (selector) => document.querySelector(selector);
const peers = new Map();
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
let socket, localStream, myId, room, name, micMuted = false, cameraOff = false;
const params = new URLSearchParams(location.search); if (params.get("room")) $("#room").value = params.get("room");

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault(); name = $("#name").value.trim(); room = $("#room").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (room.length < 3) return setStatus("Choose a room name with at least 3 characters.", true);
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    history.replaceState({}, "", `?room=${encodeURIComponent(room)}`); $("#lobby").classList.add("hidden"); $("#call").classList.remove("hidden"); $("#room-title").textContent = room;
    addTile("local", name, localStream, true); connect();
  } catch { setStatus("Camera and microphone access is required to join.", true); }
});
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:"; socket = new WebSocket(`${protocol}//${location.host}/signal?room=${encodeURIComponent(room)}`);
  socket.onopen = () => setStatus("Connecting you to the room…"); socket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "welcome") { myId = message.id; socket.send(JSON.stringify({ type: "peers" })); setStatus("You're in the meeting"); }
    if (message.type === "peers") message.peers.forEach((id) => createPeer(id, false)); if (message.type === "peer-joined") createPeer(message.id, true);
    if (message.type === "peer-left") removePeer(message.id); if (message.type === "signal") await handleSignal(message);
  }; socket.onclose = () => { if (!$("#call").classList.contains("hidden")) setStatus("Connection lost. Rejoin the meeting.", true); };
}
function createPeer(id, initiator) {
  if (peers.has(id) || id === myId) return peers.get(id); const connection = new RTCPeerConnection({ iceServers }); const peer = { connection, name: "Guest" }; peers.set(id, peer);
  localStream.getTracks().forEach((track) => connection.addTrack(track, localStream)); connection.ontrack = ({ streams }) => addTile(id, peer.name, streams[0]);
  connection.onicecandidate = ({ candidate }) => candidate && signal(id, { candidate }); connection.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(connection.connectionState)) removePeer(id); };
  if (initiator) makeOffer(id); return peer;
}
async function makeOffer(id) { const peer = peers.get(id); if (!peer) return; const offer = await peer.connection.createOffer(); await peer.connection.setLocalDescription(offer); signal(id, { description: offer, name }); }
async function handleSignal({ from, description, candidate, name: remoteName }) {
  let peer = peers.get(from); if (!peer) peer = createPeer(from, false); if (remoteName) { peer.name = remoteName; updateTileName(from, remoteName); }
  if (description) { await peer.connection.setRemoteDescription(description); if (description.type === "offer") { const answer = await peer.connection.createAnswer(); await peer.connection.setLocalDescription(answer); signal(from, { description: answer, name }); } }
  if (candidate) await peer.connection.addIceCandidate(candidate);
}
function signal(to, payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "signal", to, ...payload })); }
function addTile(id, label, stream, local = false) { let tile = document.getElementById(`tile-${id}`); if (!tile) { tile = document.createElement("article"); tile.className = "tile"; tile.id = `tile-${id}`; tile.innerHTML = `<video autoplay playsinline ${local ? "muted" : ""}></video><div class="tile-name"></div><div class="avatar">${label[0].toUpperCase()}</div>`; $("#video-grid").append(tile); } tile.querySelector(".tile-name").textContent = `${label}${local ? " (You)" : ""}`; tile.querySelector("video").srcObject = stream; }
function updateTileName(id, label) { const tile = document.getElementById(`tile-${id}`); if (tile) tile.querySelector(".tile-name").textContent = label; }
function removePeer(id) { peers.get(id)?.connection.close(); peers.delete(id); document.getElementById(`tile-${id}`)?.remove(); }
function setStatus(message, error = false) { const status = $("#status"); status.textContent = message; status.classList.toggle("error", error); }
$("#btn-mute").onclick = () => { micMuted = !micMuted; localStream.getAudioTracks().forEach((track) => track.enabled = !micMuted); $("#btn-mute span").textContent = micMuted ? "Unmute" : "Mute"; $("#btn-mute").classList.toggle("off", micMuted); };
$("#btn-cam").onclick = () => { cameraOff = !cameraOff; localStream.getVideoTracks().forEach((track) => track.enabled = !cameraOff); $("#btn-cam span").textContent = cameraOff ? "Camera on" : "Camera"; $("#btn-cam").classList.toggle("off", cameraOff); };
$("#copy-link").onclick = async () => { await navigator.clipboard.writeText(location.href); $("#copy-link").textContent = "Copied!"; setTimeout(() => $("#copy-link").textContent = "Copy invite link", 1500); };
$("#btn-leave").onclick = () => { socket?.close(); localStream?.getTracks().forEach((track) => track.stop()); location.href = location.pathname; };
