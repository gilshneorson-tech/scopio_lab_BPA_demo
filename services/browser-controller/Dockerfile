FROM node:20-slim

RUN npx playwright install-deps chromium && npx playwright install chromium

WORKDIR /app

COPY proto/ ./proto/
COPY services/browser-controller/package.json ./services/browser-controller/
RUN cd services/browser-controller && npm install --production

COPY services/browser-controller/src/ ./services/browser-controller/src/

WORKDIR /app/services/browser-controller

EXPOSE 50053
CMD ["node", "src/index.js"]
