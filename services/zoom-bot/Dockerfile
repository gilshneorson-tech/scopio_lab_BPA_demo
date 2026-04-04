## ─── Stage 1: Build Zoom Meeting SDK (C++) ───
FROM ubuntu:24.04 AS sdk-builder

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /opt/zoom-sdk

# Install C++ build dependencies
RUN apt-get update && apt-get install -y \
    build-essential cmake git curl ca-certificates zip unzip tar ninja-build pkg-config \
    libssl-dev libx11-dev libglib2.0-dev libopencv-dev \
    libdbus-1-3 libgbm1 libgl1 libx11-xcb1 \
    libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
    libxcb-shape0 libxcb-shm0 libxcb-xfixes0 libxcb-xtest0 \
    libgl1-mesa-dri libxfixes3 linux-libc-dev pkgconf \
    && rm -rf /var/lib/apt/lists/*

# Install vcpkg
RUN git clone --depth 1 https://github.com/Microsoft/vcpkg.git /opt/vcpkg \
    && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics \
    && ln -s /opt/vcpkg/vcpkg /usr/local/bin/vcpkg \
    && vcpkg install vcpkg-cmake

# Clone Zoom SDK sample
RUN git clone --depth 1 https://github.com/zoom/meetingsdk-headless-linux-sample.git .

# Rename shared library (SDK requirement)
RUN cp lib/zoomsdk/libmeetingsdk.so lib/zoomsdk/libmeetingsdk.so.1 || true

# Build
RUN cmake -B build -S . --preset debug \
    && cmake --build build

## ─── Stage 2: Runtime (Node.js + C++ SDK binary) ───
FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies for SDK + audio
# Use || true for packages that may differ between Debian/Ubuntu versions
RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio pulseaudio-utils dbus \
    xvfb xauth \
    ffmpeg curl \
    libdbus-1-3 libgbm1 libglib2.0-0 \
    libx11-6 libx11-xcb1 libxcb-image0 libxcb-keysyms1 \
    libxcb-randr0 libxcb-shape0 libxcb-shm0 libxcb-xfixes0 \
    libxcb-xtest0 libxfixes3 \
    libssl3 \
    && apt-get install -y --no-install-recommends libasound2 libgl1 libgl1-mesa-dri 2>/dev/null \
    || apt-get install -y --no-install-recommends libasound2t64 libgl1-mesa-glx 2>/dev/null \
    || true \
    && apt-get install -y --no-install-recommends libopencv-core4.5d libopencv-imgproc4.5d 2>/dev/null \
    || apt-get install -y --no-install-recommends libopencv-core406t64 libopencv-imgproc406t64 2>/dev/null \
    || true \
    && rm -rf /var/lib/apt/lists/*

# Copy built SDK binary + shared libraries
COPY --from=sdk-builder /opt/zoom-sdk/build/zoomsdk /opt/zoom-sdk/build/zoomsdk
COPY --from=sdk-builder /opt/zoom-sdk/lib/zoomsdk/ /opt/zoom-sdk/lib/zoomsdk/

ENV LD_LIBRARY_PATH=/opt/zoom-sdk/lib/zoomsdk
ENV SDK_BUILD_DIR=/opt/zoom-sdk/build

WORKDIR /app

# Install Node.js dependencies
COPY proto/ ./proto/
COPY services/zoom-bot/package.json ./services/zoom-bot/
RUN cd services/zoom-bot && npm install --production

COPY services/zoom-bot/src/ ./services/zoom-bot/src/

WORKDIR /app/services/zoom-bot

RUN mkdir -p /data/audio /tmp/zoom-audio

# Entrypoint: start PulseAudio + Xvfb, then Node.js
CMD bash -c "\
    mkdir -p /var/run/dbus && \
    dbus-uuidgen > /var/lib/dbus/machine-id 2>/dev/null; \
    dbus-daemon --config-file=/usr/share/dbus-1/system.conf --print-address 2>/dev/null; \
    rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse/; \
    mkdir -p ~/.config/pulse/ && cp -r /etc/pulse/* ~/.config/pulse/ 2>/dev/null; \
    pulseaudio -D --exit-idle-time=-1 --system --disallow-exit 2>/dev/null; \
    pactl load-module module-null-sink sink_name=SpeakerOutput 2>/dev/null; \
    pactl set-default-sink SpeakerOutput 2>/dev/null; \
    pactl set-default-source SpeakerOutput.monitor 2>/dev/null; \
    echo '[General]' > ~/.config/zoomus.conf; \
    echo 'system.audio.type=default' >> ~/.config/zoomus.conf; \
    Xvfb :99 -screen 0 1920x1080x24 -ac &>/dev/null & \
    export DISPLAY=:99; \
    node src/index.js"
