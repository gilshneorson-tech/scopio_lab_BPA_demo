FROM node:20-slim

WORKDIR /app

COPY proto/ ./proto/
COPY services/claude-wrapper/package.json ./services/claude-wrapper/
RUN cd services/claude-wrapper && npm install --production

COPY services/claude-wrapper/src/ ./services/claude-wrapper/src/

WORKDIR /app/services/claude-wrapper

EXPOSE 50052
CMD ["node", "src/index.js"]
