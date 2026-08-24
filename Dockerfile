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

# The server binds an unprivileged port and writes nothing to disk, so it has
# no reason to run as root. node:20-alpine ships this user.
USER node

# appws.js binds SERVER_PORT/PORT (default 3000) on 0.0.0.0 and auto-detects
# TLS vs plaintext per connection, so it runs fine behind a TLS-terminating
# proxy (Fly/Caddy/nginx) with no code change.
EXPOSE 3000

# Any unmatched path serves the decoy with a 200 (health hits are deliberately
# not counted in stats), and the image has no curl — probe with Node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "http.get('http://127.0.0.1:'+(process.env.SERVER_PORT||process.env.PORT||3000)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# UUID and WSPATH must be supplied at runtime (fly secrets / -e). The bundled
# default UUID in appws.js is insecure and must not be used in production.
CMD ["node", "appws.js"]
