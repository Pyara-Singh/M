const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: "*" } });

// ======================
// MEDIASOUP SETUP
// ======================
let worker;
const routers = {}; // roomId -> router

async function getOrCreateRouter(roomId) {
  if (routers[roomId]) return routers[roomId];

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

(async () => {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 40000,
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
const rooms      = {}; // roomId -> { peers: Set<socketId> }
const peers      = {}; // socketId -> { ...peerData }
const transports = {}; // transportId -> transport
const producers  = {}; // producerId -> producer
const consumers  = {}; // consumerId -> consumer

// ======================
// HELPERS
// ======================
const getPeer = (id) => peers[id];

function roomPeerList(roomId) {
  if (!rooms[roomId]) return [];
  return [...rooms[roomId].peers].map(id => {
    const p = peers[id];
    return p ? { id, displayName: p.displayName, audioMuted: p.audioMuted, videoOff: p.videoOff } : null;
  }).filter(Boolean);
}

async function cleanupPeer(socketId) {
  const peer = peers[socketId];
  if (!peer) return;

  const { roomId } = peer;

  // 1. Close and delete Consumers
  for (const id of peer.consumerIds) {
    if (consumers[id]) consumers[id].close();
    delete consumers[id];
  }

  // 2. Close and delete Producers
  for (const id of peer.producerIds) {
    if (producers[id]) producers[id].close();
    delete producers[id];
  }

  // 3. Close and delete Transports
  for (const id of peer.transportIds) {
    if (transports[id]) transports[id].close();
    delete transports[id];
  }

  // 4. Remove from room
  if (rooms[roomId]) {
    rooms[roomId].peers.delete(socketId);
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
  
  socket.on("joinRoom", async ({ roomId, displayName }, callback) => {
    try {
      if (!rooms[roomId]) rooms[roomId] = { peers: new Set() };
      rooms[roomId].peers.add(socket.id);

      peers[socket.id] = {
        socket,
        roomId,
        displayName: displayName || `User-${socket.id.slice(0, 4)}`,
        transportIds: new Set(),
        producerIds:  new Set(),
        consumerIds:  new Set(),
        audioMuted:   false,
        videoOff:     false
      };

      socket.join(roomId);
      const router = await getOrCreateRouter(roomId);

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

      socket.to(roomId).emit("peerJoined", {
        id: socket.id,
        displayName: peers[socket.id].displayName,
        audioMuted: false,
        videoOff: false
      });

      callback({ rtpCapabilities: router.rtpCapabilities, existingPeers, existingProducers });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on("createTransport", async ({ direction }, callback) => {
    try {
      const peer = getPeer(socket.id);
      const router = await getOrCreateRouter(peer.roomId);

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

  socket.on("connectTransport", async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = transports[transportId];
      if (transport) await transport.connect({ dtlsParameters });
      callback?.({});
    } catch (err) {
      callback?.({ error: err.message });
    }
  });

  socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const peer = getPeer(socket.id);
      const transport = transports[transportId];
      
      const producer = await transport.produce({ kind, rtpParameters, appData });
      producer.on("transportclose", () => {
        peer.producerIds.delete(producer.id);
        delete producers[producer.id];
      });

      producers[producer.id] = producer;
      peer.producerIds.add(producer.id);

      callback({ id: producer.id });
      socket.to(peer.roomId).emit("newProducer", { producerId: producer.id, peerId: socket.id, kind: producer.kind });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, callback) => {
    try {
      const peer = getPeer(socket.id);
      const router = routers[peer.roomId];
      const transport = transports[transportId];

      if (!router.canConsume({ producerId, rtpCapabilities })) return callback({ error: "Cannot consume" });

      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });

      consumer.on("transportclose", () => {
        peer.consumerIds.delete(consumer.id);
        delete consumers[consumer.id];
      });

      consumer.on("producerclose", () => {
        peer.consumerIds.delete(consumer.id);
        delete consumers[consumer.id];
        socket.emit("consumerClosed", { consumerId: consumer.id, producerId });
      });

      consumers[consumer.id] = consumer;
      peer.consumerIds.add(consumer.id);

      callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on("resumeConsumer", async ({ consumerId }, callback) => {
    const consumer = consumers[consumerId];
    if (consumer) await consumer.resume();
    callback?.({});
  });

  socket.on("toggleAudio", async ({ muted }) => {
    const peer = getPeer(socket.id);
    if (!peer) return;
    peer.audioMuted = muted;
    for (const id of peer.producerIds) {
      if (producers[id].kind === 'audio') muted ? await producers[id].pause() : await producers[id].resume();
    }
    socket.to(peer.roomId).emit("peerAudioToggled", { peerId: socket.id, muted });
  });

  socket.on("toggleVideo", async ({ videoOff }) => {
    const peer = getPeer(socket.id);
    if (!peer) return;
    peer.videoOff = videoOff;
    for (const id of peer.producerIds) {
      if (producers[id].kind === 'video') videoOff ? await producers[id].pause() : await producers[id].resume();
    }
    socket.to(peer.roomId).emit("peerVideoToggled", { peerId: socket.id, videoOff });
  });

  socket.on("disconnect", async () => {
    const peer = peers[socket.id];
    if (!peer) return;
    const { roomId } = peer;
    await cleanupPeer(socket.id);
    io.to(roomId).emit("peerLeft", { peerId: socket.id });
  });
});

server.listen(3001, () => console.log("SFU running on :3001"));