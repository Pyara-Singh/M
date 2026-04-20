const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: "*" } });

let worker;
let router;

(async () => {
  worker = await mediasoup.createWorker();

  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000
      }
    ]
  });

  console.log("SFU Ready");
})();

// ======================
// DATA STRUCTURES
// ======================
let rooms = {}; // roomId -> { peers: [] }
let peers = {}; // socketId -> peer
let transports = {};
let producers = {};
let consumers = {};

// ======================
// SOCKET LOGIC
// ======================
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", ({ roomId }, callback) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { peers: [] };
    }

    rooms[roomId].peers.push(socket.id);

    peers[socket.id] = {
      socket,
      roomId,
      transports: [],
      producers: [],
      consumers: []
    };

    socket.join(roomId);

    callback(router.rtpCapabilities);
  });

  socket.on("createTransport", async (callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "127.0.0.1", announcedIp: null }],
      enableUdp: true,
      enableTcp: true
    });

    transports[transport.id] = transport;

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  socket.on("connectTransport", async ({ transportId, dtlsParameters }) => {
    await transports[transportId].connect({ dtlsParameters });
  });

  // PRODUCE
  socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
    const producer = await transports[transportId].produce({
      kind,
      rtpParameters
    });

    producers[producer.id] = producer;
    peers[socket.id].producers.push(producer.id);

    callback({ id: producer.id });

    // 🔥 notify others in room
    const { roomId } = peers[socket.id];
    socket.to(roomId).emit("newProducer", {
      producerId: producer.id
    });
  });

  // GET PRODUCERS
  socket.on("getProducers", (callback) => {
    const { roomId } = peers[socket.id];

    let producerList = [];

    rooms[roomId].peers.forEach(id => {
      if (id !== socket.id) {
        producerList.push(...peers[id].producers);
      }
    });

    callback(producerList);
  });

  // CONSUME
  socket.on("consume", async ({ producerId, rtpCapabilities, transportId }, callback) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      callback(null);
      return;
    }

    const transport = transports[transportId];
    if (!transport) {
      callback(null);
      return;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false
    });

    consumers[consumer.id] = consumer;
    peers[socket.id].consumers.push(consumer.id);

    callback({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  });
});

server.listen(3001, () => {
  console.log("SFU running on 3001");
});