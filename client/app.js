import * as mediasoupClient from "mediasoup-client";
import { io } from "socket.io-client";

const socket = io("http://localhost:3001");

let device;
let producerTransport;
let consumerTransport;

let localStream;

const videoContainer = document.getElementById("videos");
const params = new URLSearchParams(window.location.search);
let roomId = params.get("room");
if (!roomId) {
  const data = await fetch("http://localhost:8080/create-room")
    .then(res => res.json());

  roomId = data.id;

  // redirect to URL with room
  window.location.href = `/?room=${roomId}`;
}

// =================
// START
// =================
async function start() {
  await getMedia();

  const rtpCapabilities = await new Promise(resolve => {
    socket.emit("joinRoom", {roomId}, resolve);
  });

  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });

  await createSendTransport();
  await createRecvTransport();

  const producers = await new Promise(resolve => {
    socket.emit("getProducers", resolve);
  });

  producers.forEach(id => consume(id));

  socket.on("newProducer", ({ producerId }) => {
    consume(producerId);
  });
}

// =================
// MEDIA
// =================
async function getMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });

  const video = document.createElement("video");
  video.srcObject = localStream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // mute local to avoid feedback
  video.style.width = "300px";
  videoContainer.appendChild(video);
}

// =================
// SEND
// =================
async function createSendTransport() {
  const params = await new Promise(resolve => {
    socket.emit("createTransport", resolve);
  });

  producerTransport = device.createSendTransport(params);

  producerTransport.on("connect", ({ dtlsParameters }, cb) => {
    socket.emit("connectTransport", {
      transportId: params.id,
      dtlsParameters
    });
    cb();
  });

  producerTransport.on("produce", ({ kind, rtpParameters }, cb) => {
    socket.emit("produce", {
      transportId: params.id,
      kind,
      rtpParameters
    }, ({ id }) => cb({ id }));
  });

  for (const track of localStream.getTracks()) {
    await producerTransport.produce({ track });
  }
}

// =================
// RECEIVE
// =================
async function createRecvTransport() {
  const params = await new Promise(resolve => {
    socket.emit("createTransport", resolve);
  });

  consumerTransport = device.createRecvTransport(params);

  consumerTransport.on("connect", ({ dtlsParameters }, cb) => {
    socket.emit("connectTransport", {
      transportId: params.id,
      dtlsParameters
    });
    cb();
  });
}

// =================
// CONSUME
// =================
async function consume(producerId) {
  const data = await new Promise(resolve => {
    socket.emit("consume", {
      producerId,
      rtpCapabilities: device.rtpCapabilities,
      transportId: consumerTransport.id
    }, resolve);
  });

  if (!data) return;

  const consumer = await consumerTransport.consume(data);

  const stream = new MediaStream();
  stream.addTrack(consumer.track);

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.style.width = "300px";

  videoContainer.appendChild(video);
}

window.start = start;

start();