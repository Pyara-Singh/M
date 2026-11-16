const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const mediasoup = require("mediasoup");
const { loadConfig } = require("./config");
const { verifyJoinToken } = require("../../packages/contracts/join-token");

const app = express();
const server = http.createServer(app);
const config = loadConfig();
const io = socketIO(server, { cors: { origin: config.origins }, maxHttpBufferSize: 100000 });
app.get("/health", (_req, res) => res.status(worker ? 200 : 503).json({ ready: Boolean(worker) }));

// ======================
// MEDIASOUP SETUP
// ======================
let worker; // The Mediasoup worker (single CPU process).
const routers = {}; // roomId -> Mediasoup Router. Each room gets its own router to isolate media.
const routerCreations = new Map();

/**
 * Gets an existing router for a room or creates a new one if it doesn't exist.
 * A Router is like a virtual room that handles media routing for all peers in it.
 */
async function getOrCreateRouter(roomId) {
  if (routers[roomId]) return routers[roomId];
  if (routerCreations.has(roomId)) return routerCreations.get(roomId);

  // Create a new Router with specific media codecs (Opus for audio, VP8/H264 for video).
  const creation = worker.createRouter({
    mediaCodecs: [
      { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
      { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
      {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 }
      }
    ]
  }).then(router => {
    routers[roomId] = router;
    router.on("workerclose", () => { delete routers[roomId]; });
    return router;
  }).finally(() => routerCreations.delete(roomId));
  routerCreations.set(roomId, creation);
  return creation;
}

// Global initialization: Start the Mediasoup Worker process.
(async () => {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: config.rtcMinPort,
    rtcMaxPort: config.rtcMaxPort
  });
  worker.on("died", () => {
    console.error("mediasoup worker died — exiting");
    process.exit(1);
  });
  server.listen(config.port, () => console.log(`SFU ready on :${config.port}`));
})().catch(err => { console.error("SFU startup failed", err); process.exit(1); });

// ======================
// DATA STRUCTURES
// ======================
// These objects act as the "database" for the SFU's current state.
const rooms = Object.create(null);
const peers = Object.create(null);
const transports = Object.create(null);
const producers = Object.create(null);
const consumers = Object.create(null);

// ======================
// HELPERS
// ======================
const getPeer = (id) => peers[id];

/**
 * Returns a list of active peers in a room with their current metadata.
 */
function roomPeerList(roomId) {
  if (!rooms[roomId]) return [];
  return [...rooms[roomId].peers].map(id => {
    const p = peers[id];
    return p ? { id, displayName: p.displayName, audioMuted: p.audioMuted, videoOff: p.videoOff } : null;
  }).filter(Boolean);
}

/**
 * Performs cleanup when a user leaves (closes all their transports, producers, and consumers).
 */
async function cleanupPeer(socketId) {
  const peer = peers[socketId];
  if (!peer) return;

  const { roomId } = peer;

  // 1. Close and delete Consumers (tracks this peer was receiving).
  for (const id of peer.consumerIds) {
    if (consumers[id]) consumers[id].close();
    delete consumers[id];
  }

  // 2. Close and delete Producers (tracks this peer was sending).
  for (const id of peer.producerIds) {
    if (producers[id]) producers[id].close();
    delete producers[id];
  }

  // 3. Close and delete Transports (the WebRTC connections).
  for (const id of peer.transportIds) {
    if (transports[id]) transports[id].close();
    delete transports[id];
  }

  // 4. Remove the peer from the room's set.
  if (rooms[roomId]) {
    rooms[roomId].peers.delete(socketId);
    // If the room is now empty, close the router to save resources.
    if (rooms[roomId].peers.size === 0) {
      if (routers[roomId]) routers[roomId].close();
      delete routers[roomId];
      delete rooms[roomId];
    }
  }

  delete peers[socketId];
}

// ======================
// SOCKET LOGIC
// ======================
io.on("connection", (socket) => {
  socket.use(([event, payload, callback], next) => {
    const ackEvents = new Set(["joinRoom", "createTransport", "connectTransport", "produce", "consume", "resumeConsumer"]);
    if (ackEvents.has(event) && typeof callback !== "function") return;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      if (typeof callback === "function") callback({ error: "Invalid payload" });
      return;
    }
    next();
  });

  /**
   * Event: joinRoom
   * Triggered when a client wants to enter a meeting room.
   */
  socket.on("joinRoom", async ({ roomId, displayName, token }, callback) => {
    let joined = false;
    try {
      if (peers[socket.id]) throw new Error("Already joined a room");
      if (typeof roomId !== "string" || !/^[a-zA-Z0-9_-]{3,64}$/.test(roomId)) throw new Error("Invalid room ID");
      if (config.joinTokenSecret) {
        const claims = verifyJoinToken(token, config.joinTokenSecret, roomId);
        if (!claims) throw new Error("Invalid or expired join token");
        displayName = claims.displayName;
      }
      if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 32) throw new Error("Invalid display name");
      // 1. Initialize room and peer state.
      if (!rooms[roomId]) rooms[roomId] = { peers: new Set() };
      rooms[roomId].peers.add(socket.id);

      peers[socket.id] = {
        socket,
        roomId,
        displayName: displayName.trim(),
        transportIds: new Set(),
        producerIds: new Set(),
        consumerIds: new Set(),
        audioMuted: false,
        videoOff: false
      };
      joined = true;

      // 2. Join the Socket.io room for signaling broadcasts.
      socket.join(roomId);
      
      // 3. Get or create the Mediasoup router for this room.
      const router = await getOrCreateRouter(roomId);
      if (!socket.connected || peers[socket.id]?.roomId !== roomId) {
        if (!rooms[roomId]?.peers.size) { router.close(); delete routers[roomId]; }
        return;
      }

      // 4. Collect info about existing participants and their media.
      const existingPeers = roomPeerList(roomId).filter(p => p.id !== socket.id);
      const existingProducers = [];

      for (const peerId of rooms[roomId].peers) {
        if (peerId === socket.id) continue;
        const p = peers[peerId];
        if (!p) continue;
        for (const prodId of p.producerIds) {
          const prod = producers[prodId];
          if (prod && !prod.closed) {
            existingProducers.push({ producerId: prodId, peerId, kind: prod.kind });
          }
        }
      }

      // 5. Notify others that a new peer joined.
      socket.to(roomId).emit("peerJoined", {
        id: socket.id,
        displayName: peers[socket.id].displayName,
        audioMuted: false,
        videoOff: false
      });

      // 6. Return capabilities and existing state to the new peer.
      callback({ rtpCapabilities: router.rtpCapabilities, existingPeers, existingProducers });
    } catch (err) {
      if (joined) { await cleanupPeer(socket.id); socket.leave(roomId); }
      callback?.({ error: err.message });
    }
  });

  /**
   * Event: createTransport
   * Creates a WebRtcTransport for either sending or receiving media.
   */
  socket.on("createTransport", async (_payload, callback) => {
    try {
      const peer = getPeer(socket.id);
      if (!peer) throw new Error("Join a room first");
      const router = await getOrCreateRouter(peer.roomId);

      // WebRtcTransport handles the ICE/DTLS handshake.
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: config.listenIp, announcedIp: config.announcedIp }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000
      });

      transport.on("dtlsstatechange", state => { if (state === "closed") transport.close(); });

      transports[transport.id] = transport;
      peer.transportIds.add(transport.id);

      // Send transport parameters back to the client so it can create its local side.
      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  /**
   * Event: connectTransport
   * Finalizes the connection between the client's local transport and the server's transport.
   */
  socket.on("connectTransport", async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = transports[transportId];
      if (!getPeer(socket.id)?.transportIds.has(transportId) || !transport) throw new Error("Transport not found");
      await transport.connect({ dtlsParameters });
      callback?.({});
    } catch (err) {
      callback?.({ error: err.message });
    }
  });

  /**
   * Event: produce
   * Creates a Producer on the server. The client is now "sending" a track.
   */
  socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const peer = getPeer(socket.id);
      const transport = transports[transportId];
      if (!peer?.transportIds.has(transportId) || !transport) throw new Error("Transport not found");
      if (kind !== "audio" && kind !== "video") throw new Error("Invalid media kind");

      // A Producer represents media coming INTO the server.
      const producer = await transport.produce({ kind, rtpParameters, appData });
      
      producer.on("transportclose", () => {
        peer.producerIds.delete(producer.id);
        delete producers[producer.id];
      });

      producers[producer.id] = producer;
      peer.producerIds.add(producer.id);

      // 1. Success callback for the sender.
      callback({ id: producer.id });
      
      // 2. Broadcast to all others in the room that a "newProducer" is available to consume.
      socket.to(peer.roomId).emit("newProducer", { producerId: producer.id, peerId: socket.id, kind: producer.kind });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  /**
   * Event: consume
   * Creates a Consumer on the server. The client is now "receiving" a track from someone else.
   */
  socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, callback) => {
    try {
      const peer = getPeer(socket.id);
      const router = routers[peer.roomId];
      const transport = transports[transportId];
      if (!peer?.transportIds.has(transportId) || !transport) throw new Error("Transport not found");
      if (![...rooms[peer.roomId].peers].some(id => peers[id]?.producerIds.has(producerId))) throw new Error("Producer not found");

      // Check if the router supports the client's capabilities for this producer.
      if (!router.canConsume({ producerId, rtpCapabilities })) return callback({ error: "Cannot consume" });

      // A Consumer represents media going OUT of the server to a client.
      // We start it 'paused' and wait for the client to signal 'resume'.
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });

      consumer.on("transportclose", () => {
        peer.consumerIds.delete(consumer.id);
        delete consumers[consumer.id];
      });

      consumer.on("producerclose", () => {
        peer.consumerIds.delete(consumer.id);
        delete consumers[consumer.id];
        // Notify the client that the track they were watching is gone.
        socket.emit("consumerClosed", { consumerId: consumer.id, producerId });
      });

      consumers[consumer.id] = consumer;
      peer.consumerIds.add(consumer.id);

      // Send consumer parameters back to the client.
      callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  /**
   * Event: resumeConsumer
   * Clients call this once they have successfully created their local consumer.
   */
  socket.on("resumeConsumer", async ({ consumerId }, callback) => {
    try {
      const consumer = consumers[consumerId];
      if (!getPeer(socket.id)?.consumerIds.has(consumerId) || !consumer) throw new Error("Consumer not found");
      await consumer.resume();
      callback?.({});
    } catch (err) { callback?.({ error: err.message }); }
  });

  /**
   * Event: toggleAudio
   * Updates state and pauses/resumes the actual media flow on the server.
   */
  socket.on("toggleAudio", async ({ muted }) => {
    const peer = getPeer(socket.id);
    if (!peer || typeof muted !== "boolean") return;
    peer.audioMuted = muted;
    // Pause/Resume the server-side producers for this peer.
    for (const id of peer.producerIds) {
      if (producers[id]?.kind === 'audio') muted ? await producers[id].pause() : await producers[id].resume();
    }
    // Broadcast status change to others.
    socket.to(peer.roomId).emit("peerAudioToggled", { peerId: socket.id, muted });
  });

  /**
   * Event: toggleVideo
   * Updates state and pauses/resumes the actual media flow on the server.
   */
  socket.on("toggleVideo", async ({ videoOff }) => {
    const peer = getPeer(socket.id);
    if (!peer || typeof videoOff !== "boolean") return;
    peer.videoOff = videoOff;
    for (const id of peer.producerIds) {
      if (producers[id]?.kind === 'video') videoOff ? await producers[id].pause() : await producers[id].resume();
    }
    socket.to(peer.roomId).emit("peerVideoToggled", { peerId: socket.id, videoOff });
  });

  /**
   * Event: disconnect
   * Handles unexpected socket closures (e.g. closing the browser tab).
   */
  socket.on("disconnect", async () => {
    const peer = peers[socket.id];
    if (!peer) return;
    const { roomId } = peer;
    await cleanupPeer(socket.id);
    io.to(roomId).emit("peerLeft", { peerId: socket.id });
  });

  socket.on("chatMessage", ({ text }) => {
    const peer = getPeer(socket.id);
    if (!peer || typeof text !== "string") return;
    const message = text.trim().slice(0, 500);
    if (message) socket.to(peer.roomId).emit("chatMessage", { displayName: peer.displayName, text: message });
  });

  socket.on("reaction", ({ value }) => {
    const peer = getPeer(socket.id);
    if (!peer || typeof value !== "string") return;
    socket.to(peer.roomId).emit("reaction", { peerId: socket.id, value: value.slice(0, 8) });
  });

  socket.on("raiseHand", ({ raised }) => {
    const peer = getPeer(socket.id);
    if (!peer) return;
    socket.to(peer.roomId).emit("peerHandRaised", { peerId: socket.id, raised: Boolean(raised) });
  });
});
