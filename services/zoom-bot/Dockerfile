FROM node:20-slim

# Install audio + display tools for Zoom SDK integration
RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio \
    xvfb \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY proto/ ./proto/
COPY services/zoom-bot/package.json ./services/zoom-bot/
RUN cd services/zoom-bot && npm install --production

COPY services/zoom-bot/src/ ./services/zoom-bot/src/

WORKDIR /app/services/zoom-bot

RUN mkdir -p /data/audio

# Start PulseAudio + Xvfb, then the bot
CMD bash -c "pulseaudio --start --system --disallow-exit 2>/dev/null; \
    Xvfb :99 -screen 0 1920x1080x24 -ac &>/dev/null & \
    export DISPLAY=:99; \
    node src/index.js"
