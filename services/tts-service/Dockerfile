FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/tts-service/package.json ./services/tts-service/
# Reproducible install pinned by the workspace lockfile — a transitive dep
# bump must not change behavior the night before a demo
RUN npm ci --workspace=@scopio/tts-service --omit=dev

COPY proto/ ./proto/
COPY services/tts-service/src/ ./services/tts-service/src/

WORKDIR /app/services/tts-service

EXPOSE 50054
CMD ["node", "src/index.js"]
