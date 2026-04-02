FROM node:20-slim

WORKDIR /app

COPY proto/ ./proto/
COPY services/tts-service/package.json ./services/tts-service/
RUN cd services/tts-service && npm install --production

COPY services/tts-service/src/ ./services/tts-service/src/

WORKDIR /app/services/tts-service

EXPOSE 50054
CMD ["node", "src/index.js"]
