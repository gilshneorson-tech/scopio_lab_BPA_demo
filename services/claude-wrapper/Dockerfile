FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/claude-wrapper/package.json ./services/claude-wrapper/
# Reproducible install pinned by the workspace lockfile — a transitive dep
# bump must not change behavior the night before a demo
RUN npm ci --workspace=@scopio/claude-wrapper --omit=dev

COPY proto/ ./proto/
COPY services/claude-wrapper/src/ ./services/claude-wrapper/src/

WORKDIR /app/services/claude-wrapper

EXPOSE 50052
CMD ["node", "src/index.js"]
