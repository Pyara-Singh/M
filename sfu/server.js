const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);
// Initialize Socket.io with CORS enabled for all origins.
const io = socketIO(server, { cors: { origin: "*" } });

// ======================
// MEDIASOUP SETUP
// ======================
let worker; // The Mediasoup worker (single CPU process).
const routers = {}; // roomId -> Mediasoup Router. Each room gets its own router to isolate media.

/**
 * Gets an existing router for a room or creates a new one if it doesn't exist.
 * A Router is like a virtual room that handles media routing for all peers in it.
 */
async function getOrCreateRouter(roomId) {
  if (routers[roomId]) return routers[roomId];

  // Create a new Router with specific media codecs (Opus for audio, VP8/H264 for video).
  const router = await worker.createRouter({
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
  });

  routers[roomId] = router;
  router.on("workerclose", () => {
    delete routers[roomId];
  });

  return router;
}

// Global initialization: Start the Mediasoup Worker process.
(async () => {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 40000, // Range of ports for WebRTC traffic.
    rtcMaxPort: 49999
  });
  worker.on("died", () => {
    console.error("mediasoup worker died — exiting");
    process.exit(1);
  });
  console.log("SFU Ready on port 3001");
})();

// ======================
// DATA STRUCTURES
// ======================
// These objects act as the "database" for the SFU's current state.
const rooms = {}; // roomId -> { peers: Set<socketId> }
const peers = {}; // socketId -> { ...peerData, transportIds, producerIds, consumerIds }
const transports = {}; // transportId -> Mediasoup Transport
const producers = {}; // producerId -> Mediasoup Producer
const consumers = {}; // consumerId -> Mediasoup Consumer

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

  /**
   * Event: joinRoom
   * Triggered when a client wants to enter a meeting room.
   */
  socket.on("joinRoom", async ({ roomId, displayName }, callback) => {
    try {
      // 1. Initialize room and peer state.
      if (!rooms[roomId]) rooms[roomId] = { peers: new Set() };
      rooms[roomId].peers.add(socket.id);

      peers[socket.id] = {
        socket,
        roomId,
        displayName: displayName || `User-${socket.id.slice(0, 4)}`,
        transportIds: new Set(),
        producerIds: new Set(),
        consumerIds: new Set(),
        audioMuted: false,
        videoOff: false
      };

      // 2. Join the Socket.io room for signaling broadcasts.
      socket.join(roomId);
      
      // 3. Get or create the Mediasoup router for this room.
      const router = await getOrCreateRouter(roomId);

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
      callback({ error: err.message });
    }
  });

  /**
   * Event: createTransport
   * Creates a WebRtcTransport for either sending or receiving media.
   */
  socket.on("createTransport", async ({ direction }, callback) => {
    try {
      const peer = getPeer(socket.id);
      const router = await getOrCreateRouter(peer.roomId);

      // WebRtcTransport handles the ICE/DTLS handshake.
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1" }],
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
      if (transport) await transport.connect({ dtlsParameters });
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
    const consumer = consumers[consumerId];
    if (consumer) await consumer.resume();
    callback?.({});
  });

  /**
   * Event: toggleAudio
   * Updates state and pauses/resumes the actual media flow on the server.
   */
  socket.on("toggleAudio", async ({ muted }) => {
    const peer = getPeer(socket.id);
    if (!peer) return;
    peer.audioMuted = muted;
    // Pause/Resume the server-side producers for this peer.
    for (const id of peer.producerIds) {
      if (producers[id].kind === 'audio') muted ? await producers[id].pause() : await producers[id].resume();
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
    if (!peer) return;
    peer.videoOff = videoOff;
    for (const id of peer.producerIds) {
      if (producers[id].kind === 'video') videoOff ? await producers[id].pause() : await producers[id].resume();
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
});

server.listen(3001, () => console.log("SFU running on :3001"));