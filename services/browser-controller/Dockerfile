FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/browser-controller/package.json ./services/browser-controller/
# Reproducible install pinned by the workspace lockfile — a transitive dep
# bump must not change behavior the night before a demo
RUN npm ci --workspace=@scopio/browser-controller --omit=dev

# Install Chromium + its full OS dependency set (a hand-maintained apt list
# drifts from what Playwright's Chromium actually needs)
RUN cd services/browser-controller && npx playwright install --with-deps chromium

COPY proto/ ./proto/
COPY services/browser-controller/src/ ./services/browser-controller/src/
COPY config/test-bma.html ./config/test-bma.html

WORKDIR /app/services/browser-controller

EXPOSE 8090 50053

# The browser runs headless — no virtual display needed
CMD ["node", "src/index.js"]
