FROM node:20-slim

WORKDIR /app

COPY proto/ ./proto/
COPY services/persistence/package.json ./services/persistence/
RUN cd services/persistence && npm install --production

COPY services/persistence/src/ ./services/persistence/src/

WORKDIR /app/services/persistence

EXPOSE 50055
CMD ["node", "src/index.js"]
