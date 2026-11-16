FROM node:20-alpine

WORKDIR /app/services/mediasoup-sfu

COPY services/mediasoup-sfu/package.json services/mediasoup-sfu/package-lock.json ./
RUN npm ci --omit=dev

COPY services/mediasoup-sfu/ ./
COPY packages/contracts/ /app/packages/contracts/

EXPOSE 3001
CMD ["npm", "start"]
