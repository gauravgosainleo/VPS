FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl mariadb-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json server.js rpc-worker.js ./
COPY --chown=node:node backend ./backend
COPY --chown=node:node public ./public
COPY --chown=node:node data/employees.json ./data/employees.json

RUN mkdir -p /app/data/files /app/data/cache /app/data/spreadsheets /app/data/tmp /app/data/locks \
    && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
