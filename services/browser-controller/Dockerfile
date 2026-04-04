FROM node:20-slim

# Install Chromium dependencies + Xvfb for headless display
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY proto/ ./proto/
COPY services/browser-controller/package.json ./services/browser-controller/
RUN cd services/browser-controller && npm install --production

# Install Chromium at build time
RUN cd services/browser-controller && npx playwright install chromium

COPY services/browser-controller/src/ ./services/browser-controller/src/
COPY config/test-bma.html ./config/test-bma.html
COPY config/dashboard.html ./config/dashboard.html

WORKDIR /app/services/browser-controller

EXPOSE 8090 50053

# Use xvfb-run to provide a virtual display
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1920x1080x24", "node", "src/index.js"]
