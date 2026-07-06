FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 20 from official binary
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && node --version && npm --version

# Runtime dependencies: PulseAudio + Xvfb + Chromium deps
# (own apt-get update: reusing the previous layer's lists 404s on cache hits)
RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio pulseaudio-utils dbus \
    xvfb xauth \
    ffmpeg \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
    libgbm1 libxshmfence1 fonts-liberation \
    libx11-6 libx11-xcb1 libxcb-image0 libxcb-keysyms1 \
    libxcb-randr0 libxcb-shape0 libxcb-shm0 libxcb-xfixes0 \
    libxcb-xtest0 libxfixes3 libglib2.0-0t64 libegl1 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies + Playwright Chromium
COPY package.json package-lock.json ./
COPY services/meet-bot/package.json ./services/meet-bot/
# Reproducible install pinned by the workspace lockfile
RUN npm ci --workspace=@scopio/meet-bot --omit=dev && npx playwright install chromium

COPY proto/ ./proto/
COPY services/meet-bot/src/ ./services/meet-bot/src/
COPY config/test-bma.html ./config/test-bma.html
COPY config/scopio-background.jpg ./config/scopio-background.jpg

WORKDIR /app/services/meet-bot

RUN mkdir -p /tmp/meet-audio /data/audio

# Entrypoint: start PulseAudio (user mode) + Xvfb, configure virtual audio devices, then Node.js
CMD bash -c "\
    mkdir -p /var/run/dbus && \
    dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null; \
    dbus-daemon --config-file=/usr/share/dbus-1/system.conf --print-address 2>/dev/null; \
    export XDG_RUNTIME_DIR=/run/user/0; \
    mkdir -p \$XDG_RUNTIME_DIR; \
    rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse/ \$XDG_RUNTIME_DIR/pulse; \
    pulseaudio -D --exit-idle-time=-1 2>/dev/null; \
    sleep 1; \
    pactl load-module module-null-sink sink_name=MeetSpeaker sink_properties=device.description=MeetSpeaker; \
    pactl load-module module-null-sink sink_name=TTSPlayback sink_properties=device.description=TTSPlayback; \
    pactl load-module module-remap-source master=TTSPlayback.monitor source_name=VirtualMic source_properties=device.description=VirtualMic; \
    pactl set-default-sink MeetSpeaker; \
    pactl set-default-source VirtualMic; \
    echo '=== PulseAudio sinks ==='; pactl list short sinks; \
    echo '=== PulseAudio sources ==='; pactl list short sources; \
    Xvfb :99 -screen 0 1920x1080x24 -ac &>/dev/null & \
    export DISPLAY=:99; \
    for i in \$(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done; \
    [ -e /tmp/.X11-unix/X99 ] || echo 'WARN: Xvfb socket not ready after 10s'; \
    exec node src/index.js"
