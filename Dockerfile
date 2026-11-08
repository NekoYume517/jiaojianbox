FROM golang:1.26.10-alpine AS build
WORKDIR /src
ARG GOPROXY=https://goproxy.cn,direct
ENV CGO_ENABLED=0 GOPROXY=$GOPROXY
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY cmd/jiaojianbox-server ./cmd/jiaojianbox-server
COPY web ./web
ARG VERSION=0.6.0
RUN go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /jiaojianbox-server ./cmd/jiaojianbox-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/* && useradd --uid 1000 --create-home app && mkdir /data && chown app:app /data
ENV JJB_DATA_DIR=/data JJB_LISTEN=0.0.0.0:8765
WORKDIR /app
COPY --from=build /jiaojianbox-server ./jiaojianbox-server
USER app
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/app/jiaojianbox-server", "--healthcheck", "http://127.0.0.1:8765/health"]
CMD ["/app/jiaojianbox-server"]
