import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const TEST_PAGE_PORT = 8090;
let BMA_URL = process.env.BMA_URL || '';

// ─── Browser session ───

let browser = null;
let page = null;

async function initBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      ...(process.env.DISPLAY ? [] : ['--headless']),
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'ScopioDemo/1.0',
  });

  page = await context.newPage();
  logger.info('Browser initialized');
}

// ─── Test page server ───

function startTestPageServer() {
  const htmlPath = resolve(__dirname, '../../../config/test-bma.html');
  let html;
  try {
    html = readFileSync(htmlPath, 'utf-8');
  } catch {
    logger.error({ htmlPath }, 'test-bma.html not found');
    return;
  }

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  server.listen(TEST_PAGE_PORT, () => {
    logger.info(`Test BMA page served at http://localhost:${TEST_PAGE_PORT}`);
  });
}

// ─── Section navigation map ───

const SECTION_MAP = {
  home: async () => {
    await page.goto(BMA_URL);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  },
  overview: async () => {
    const clicked = await page.click('[data-section="overview"], nav a[href*="overview"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#overview`);
  },
  scan_viewer: async () => {
    const clicked = await page.click('[data-section="scan"], nav a[href*="scan"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#scan`);
  },
  ndc_panel: async () => {
    const clicked = await page.click('[data-section="ndc"], nav a[href*="differential"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#ndc`);
  },
  quantification: async () => {
    const clicked = await page.click('[data-section="quantification"], nav a[href*="quantif"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#quantification`);
  },
  remote_access: async () => {
    const clicked = await page.click('[data-section="remote"], nav a[href*="remote"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#remote`);
  },
  report_export: async () => {
    const clicked = await page.click('[data-section="report"], nav a[href*="report"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#report`);
  },
  integration: async () => {
    const clicked = await page.click('[data-section="integration"], nav a[href*="integrat"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#integration`);
  },
  summary: async () => {
    const clicked = await page.click('[data-section="summary"], nav a[href*="summary"]').then(() => true).catch(() => false);
    if (!clicked) await page.goto(`${BMA_URL}#summary`);
  },
};

// ─── Action executors ───

async function executeAction(action) {
  if (!page) throw new Error('Browser not initialized');

  switch (action.type) {
    case 'NAVIGATE': {
      const navFn = SECTION_MAP[action.section];
      if (navFn) {
        await navFn();
        await page.waitForTimeout(300); // let JS settle
      } else {
        logger.warn({ section: action.section }, 'Unknown section');
      }
      break;
    }
    case 'HIGHLIGHT': {
      if (action.selector) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.style.outline = '3px solid #ff6b00';
            el.style.outlineOffset = '2px';
            setTimeout(() => {
              el.style.outline = '';
              el.style.outlineOffset = '';
            }, 3000);
          }
        }, action.selector);
      }
      break;
    }
    case 'SCROLL': {
      const delta = (action.direction === 'down' ? 1 : -1) * (action.amount || 300);
      await page.mouse.wheel(0, delta);
      break;
    }
    case 'CLICK': {
      if (action.selector) {
        await page.click(action.selector);
      }
      break;
    }
    case 'WAIT': {
      await page.waitForTimeout(action.wait_ms || 1000);
      break;
    }
    case 'SCREENSHOT': {
      return await page.screenshot({ type: 'png' });
    }
  }
  return null;
}

// ─── gRPC server ───

function loadBrowserProto() {
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, 'browser.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

async function handleExecuteAction(call, callback) {
  try {
    const { type, selector, section, direction, amount, wait_ms } = call.request;
    const actionType = ['NAVIGATE', 'HIGHLIGHT', 'SCROLL', 'CLICK', 'WAIT', 'SCREENSHOT'][
      typeof type === 'number' ? type : 0
    ] || type;

    await executeAction({
      type: actionType,
      selector,
      section,
      direction,
      amount,
      wait_ms,
    });

    callback(null, {
      success: true,
      current_url: page?.url() || '',
    });
  } catch (err) {
    logger.error({ err }, 'Action execution failed');
    callback(null, { success: false, message: err.message });
  }
}

async function handleInitialize(call, callback) {
  try {
    const { url, username, password } = call.request;

    if (!browser) {
      await initBrowser();
    }

    const targetUrl = url || BMA_URL;
    if (targetUrl) {
      await page.goto(targetUrl);

      if (username && password) {
        await page.fill('input[type="text"], input[name="username"], #username', username).catch(() => {});
        await page.fill('input[type="password"], #password', password).catch(() => {});
        await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
      }
    }

    callback(null, { success: true, current_url: page?.url() || '' });
  } catch (err) {
    logger.error({ err }, 'Browser init failed');
    callback(null, { success: false, message: err.message });
  }
}

async function handleScreenshot(call, callback) {
  try {
    const imageData = await page.screenshot({ type: 'png' });
    callback(null, { image_data: imageData, content_type: 'image/png' });
  } catch (err) {
    callback(null, { image_data: Buffer.alloc(0), content_type: '' });
  }
}

async function handleGetPageState(call, callback) {
  callback(null, {
    url: page?.url() || '',
    title: await page?.title().catch(() => '') || '',
    is_loaded: !!page,
  });
}

// ─── Main ───

async function main() {
  // If no BMA_URL, serve the test page locally
  if (!process.env.BMA_URL) {
    startTestPageServer();
    BMA_URL = `http://localhost:${TEST_PAGE_PORT}`;
    logger.info({ BMA_URL }, 'Using test BMA page (no BMA_URL set)');
  }

  const proto = loadBrowserProto();
  const server = new grpc.Server();

  server.addService(proto.scopio.browser.BrowserController.service, {
    executeAction: handleExecuteAction,
    initialize: handleInitialize,
    screenshot: handleScreenshot,
    getPageState: handleGetPageState,
  });

  const port = process.env.GRPC_PORT || '50053';
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) throw err;
    logger.info(`Browser controller gRPC listening on :${port}`);
  });

  // Pre-init browser and navigate to BMA
  await initBrowser();
  await page.goto(BMA_URL);
  logger.info({ url: BMA_URL }, 'Browser pre-loaded BMA');
}

main().catch((err) => {
  logger.error(err, 'Failed to start browser-controller');
  process.exit(1);
});
