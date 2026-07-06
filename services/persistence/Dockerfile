FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/persistence/package.json ./services/persistence/
# Reproducible install pinned by the workspace lockfile — a transitive dep
# bump must not change behavior the night before a demo
RUN npm ci --workspace=@scopio/persistence --omit=dev

COPY proto/ ./proto/
COPY services/persistence/src/ ./services/persistence/src/

WORKDIR /app/services/persistence

EXPOSE 50055
CMD ["node", "src/index.js"]
