FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /lesgomeet-api

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /lesgomeet-api /lesgomeet-api
EXPOSE 8080
CMD ["/lesgomeet-api"]
