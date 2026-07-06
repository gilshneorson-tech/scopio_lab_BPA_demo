FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY package.json package-lock.json ./
COPY services/meeting-launcher/package.json ./services/meeting-launcher/
# Reproducible install pinned by the workspace lockfile
RUN npm ci --workspace=@scopio/meeting-launcher --omit=dev

COPY services/meeting-launcher/ ./services/meeting-launcher/

WORKDIR /app/services/meeting-launcher

EXPOSE 8080
CMD ["node", "index.js"]
