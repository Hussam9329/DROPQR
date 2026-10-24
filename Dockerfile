FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# Uploaded files + database live here. Mount a volume on this path
# (Railway: add a Volume at /app/data. Compose: see docker-compose.yml).
RUN mkdir -p /app/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
