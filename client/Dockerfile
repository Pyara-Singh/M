FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

ARG VITE_SFU_URL=http://localhost:3001
ARG VITE_GO_URL=http://localhost:8080
ENV VITE_SFU_URL=${VITE_SFU_URL}
ENV VITE_GO_URL=${VITE_GO_URL}

RUN npm run build

FROM nginx:stable-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
