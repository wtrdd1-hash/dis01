FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

ENV NODE_ENV=production
STOPSIGNAL SIGTERM
USER node

CMD ["node", "src/index.js"]
