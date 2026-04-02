FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY proto/ ./proto/
COPY services/zoom-bot/package.json ./services/zoom-bot/
RUN cd services/zoom-bot && npm install --production

COPY services/zoom-bot/src/ ./services/zoom-bot/src/

WORKDIR /app/services/zoom-bot

CMD ["node", "src/index.js"]
