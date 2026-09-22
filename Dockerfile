# syntax=docker/dockerfile:1
#
# Builds a single container that bundles:
#   1) the gosom/google-maps-scraper engine (compiled from source, run in
#      "-web" mode as an internal, non-public API on 127.0.0.1)
#   2) our own management UI + reverse-proxy (server/server.js, plain Node,
#      zero npm dependencies) exposed on the public port.
#
# Upstream project: https://github.com/gosom/google-maps-scraper (MIT)

ARG GO_VERSION=1.23
ARG SCRAPER_REF=master

# ---------------------------------------------------------------------------
# Stage: build the scraper binary + fetch its headless Chromium
# ---------------------------------------------------------------------------
FROM golang:${GO_VERSION}-trixie AS build
ARG SCRAPER_REF

WORKDIR /src
RUN git clone --depth 1 --branch "${SCRAPER_REF}" \
      https://github.com/gosom/google-maps-scraper.git .

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
ENV PLAYWRIGHT_DRIVER_PATH=/opt/ms-playwright-go
# GOTOOLCHAIN=auto (Go's default) lets `go build`/`go run` fetch whatever
# toolchain version go.mod requires, even if it's newer than this image's Go.
RUN go mod download

# Installs the Chromium build Playwright needs, plus its OS-level deps,
# using the exact playwright-go version pinned in the cloned repo's go.sum.
RUN go run github.com/mxschmitt/playwright-go/cmd/playwright install chromium --with-deps

RUN CGO_ENABLED=0 go build -ldflags="-w -s" -o /usr/bin/google-maps-scraper .

# ---------------------------------------------------------------------------
# Stage: final runtime image
# ---------------------------------------------------------------------------
FROM debian:trixie-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
ENV PLAYWRIGHT_DRIVER_PATH=/opt/ms-playwright-go
ENV DATA_FOLDER=/data
ENV SCRAPER_INTERNAL_PORT=8081
ENV NODE_ENV=production

# Runtime shared libs required by headless Chromium (mirrors upstream's own
# Dockerfile) + Node.js (Debian trixie ships a current Node 20.x/22.x).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libdbus-1-3 libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 ca-certificates \
      nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/browsers /opt/browsers
COPY --from=build /opt/ms-playwright-go /opt/ms-playwright-go
COPY --from=build /usr/bin/google-maps-scraper /usr/bin/google-maps-scraper

WORKDIR /app
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && mkdir -p "${DATA_FOLDER}" \
    && chown -R appuser:appuser "${DATA_FOLDER}" /app /opt/browsers /opt/ms-playwright-go
USER appuser

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
