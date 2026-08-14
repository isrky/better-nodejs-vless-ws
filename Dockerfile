# Minimal image for the Node build (appws.js). It has zero npm dependencies —
# only Node built-ins plus src/vless.js — so there is nothing to install.
FROM node:20-alpine

WORKDIR /app

# Copy only what the server needs at runtime. Nothing under local/ (secrets)
# is ever included; see .dockerignore.
COPY appws.js ./
COPY src/vless.js ./src/vless.js

# appws.js binds SERVER_PORT/PORT (default 3000) on 0.0.0.0 and auto-detects
# TLS vs plaintext per connection, so it runs fine behind a TLS-terminating
# proxy (Fly/Caddy/nginx) with no code change.
EXPOSE 3000

# UUID and WSPATH must be supplied at runtime (fly secrets / -e). The bundled
# default UUID in appws.js is insecure and must not be used in production.
CMD ["node", "appws.js"]
