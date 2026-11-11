FROM debian:bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/* && useradd --uid 1000 --create-home app && mkdir /data && chown app:app /data

FROM base AS build
# Use the checksum-verified official toolchain instead of a large compiler image.
# The regional official download remains reachable when registry layers are slow.
ADD https://golang.google.cn/dl/go1.26.10.linux-amd64.tar.gz /tmp/go.tar.gz
RUN echo "ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5  /tmp/go.tar.gz" | sha256sum -c - && tar -C /usr/local -xzf /tmp/go.tar.gz && rm /tmp/go.tar.gz
WORKDIR /src
ARG GOPROXY=https://goproxy.cn,direct
ENV PATH=/usr/local/go/bin:$PATH CGO_ENABLED=0 GOPROXY=$GOPROXY GOSUMDB=sum.golang.google.cn
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY cmd/jiaojianbox-server ./cmd/jiaojianbox-server
COPY web ./web
ARG VERSION=0.6.14
RUN go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /jiaojianbox-server ./cmd/jiaojianbox-server

FROM base
ENV JJB_DATA_DIR=/data JJB_LISTEN=0.0.0.0:8765
WORKDIR /app
COPY --from=build /jiaojianbox-server ./jiaojianbox-server
USER app
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/app/jiaojianbox-server", "--healthcheck", "http://127.0.0.1:8765/health"]
CMD ["/app/jiaojianbox-server"]
