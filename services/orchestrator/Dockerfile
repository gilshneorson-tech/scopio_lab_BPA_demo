FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY proto/ ./proto/
COPY config/ ./config/
COPY services/orchestrator/package.json ./services/orchestrator/
RUN cd services/orchestrator && npm install --production

COPY services/orchestrator/src/ ./services/orchestrator/src/

WORKDIR /app/services/orchestrator

EXPOSE 3000 50051

HEALTHCHECK --interval=10s --retries=3 CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
