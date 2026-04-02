FROM node:20-slim

WORKDIR /app

# Copy proto definitions
COPY proto/ ./proto/

# Copy service
COPY services/orchestrator/package.json ./services/orchestrator/
RUN cd services/orchestrator && npm install --production

COPY services/orchestrator/src/ ./services/orchestrator/src/

WORKDIR /app/services/orchestrator

EXPOSE 3000 50051
CMD ["node", "src/index.js"]
