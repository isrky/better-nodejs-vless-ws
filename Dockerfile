# Minimal image for the Node build (appws.js). It has zero npm dependencies —
# only Node built-ins plus the shared src/ modules — so there is nothing to
# install.
FROM node:20-alpine

WORKDIR /app

# Copy only what the server needs at runtime. The list is explicit rather than
# `COPY src/ ./src/` so the Cloudflare Worker build (src/worker/) and the test
# suite never ship in the image. Nothing under local/ (secrets) is ever
# included; see .dockerignore.
COPY appws.js ./
COPY src/vless.js src/decoy.js ./src/
COPY src/node/ ./src/node/

# appws.js binds SERVER_PORT/PORT (default 3000) on 0.0.0.0 and auto-detects
# TLS vs plaintext per connection, so it runs fine behind a TLS-terminating
# proxy (Fly/Caddy/nginx) with no code change.
EXPOSE 3000

# UUID and WSPATH must be supplied at runtime (fly secrets / -e). The bundled
# default UUID in appws.js is insecure and must not be used in production.
CMD ["node", "appws.js"]
