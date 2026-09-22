# syntax=docker/dockerfile:1
#
# Builds a single container that bundles:
#   1) the gosom/google-maps-scraper engine (compiled from source, run in
#      "-web" mode as an internal, non-public API on 127.0.0.1)
#   2) our own management UI + reverse-proxy (server/server.js, plain Node,
#      zero npm dependencies) exposed on the public port.
#
# Upstream project: https://github.com/gosom/google-maps-scraper (MIT)

# Matches the Go version the upstream go.mod requires. Note that Debian-trixie
# golang images only exist from 1.24 up — older tags like 1.23-trixie do not
# exist and the build fails at image pull.
ARG GO_VERSION=1.27.1
ARG SCRAPER_REF=main

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
# GOTOOLCHAIN=auto (Go's default) lets the build fetch whatever toolchain
# go.mod requires, so a version bump upstream doesn't break this image.
RUN go mod download

# Install the Chromium build Playwright needs, plus its OS-level deps. The
# playwright CLI version is read from the cloned repo's own go.mod so it can
# never drift from the version the compiled binary drives the browser with.
# `go install pkg@version` resolves its own dependencies independently, which
# `go run pkg` would not: the main module's go.sum lacks entries for the CLI's
# own deps.
RUN PW_VERSION="$(go list -m -f '{{.Version}}' github.com/mxschmitt/playwright-go)" \
    && echo "playwright-go: ${PW_VERSION}" \
    && go install "github.com/mxschmitt/playwright-go/cmd/playwright@${PW_VERSION}" \
    && playwright install chromium --with-deps

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
