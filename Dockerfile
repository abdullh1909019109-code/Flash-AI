# FLASH AGENT — production image
FROM node:20-bookworm-slim

# better-sqlite3 ships prebuilt binaries; keep build tooling available as a fallback
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data/uploads && useradd -m -u 10001 flash && chown -R flash:flash /app
USER flash

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/index.js"]

