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

// Clicking a missing selector on the real BMA UI must fall back to hash
// navigation in ~1s, not stall a live demo step for Playwright's default 30s
const CLICK_TIMEOUT_MS = 1000;

const VALID_ACTIONS = new Set(['NAVIGATE', 'HIGHLIGHT', 'SCROLL', 'CLICK', 'WAIT', 'SCREENSHOT']);

// ─── Browser session ───

let browser = null;
let page = null;
let initializing = null;

async function launchBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // A crashed Chromium must not fail every action for the rest of the demo —
  // the next action relaunches via ensureBrowser()
  browser.on('disconnected', () => {
    logger.error('Browser disconnected — will relaunch on next action');
    browser = null;
    page = null;
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'ScopioDemo/1.0',
  });

  page = await context.newPage();
  logger.info('Browser initialized');
}

async function ensureBrowser() {
  if (browser && page && !page.isClosed()) return;
  // Serialize concurrent relaunch attempts
  if (!initializing) {
    initializing = (async () => {
      try {
        if (browser) await browser.close().catch(() => {});
        await launchBrowser();
        if (BMA_URL) await page.goto(BMA_URL).catch(() => {});
      } finally {
        initializing = null;
      }
    })();
  }
  await initializing;
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

  server.on('error', (err) => {
    logger.error({ err: err.message }, 'Test page server error — continuing without it');
  });

  server.listen(TEST_PAGE_PORT, () => {
    logger.info(`Test BMA page served at http://localhost:${TEST_PAGE_PORT}`);
  });
}

// ─── Section navigation map ───

async function clickOrHash(selector, hash) {
  const clicked = await page
    .click(selector, { timeout: CLICK_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await page.goto(`${BMA_URL}#${hash}`, { timeout: 10000 });
}

const SECTION_MAP = {
  home: async () => {
    await page.goto(BMA_URL);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  },
  overview: () => clickOrHash('[data-section="overview"], nav a[href*="overview"]', 'overview'),
  scan_viewer: () => clickOrHash('[data-section="scan"], nav a[href*="scan"]', 'scan'),
  ndc_panel: () => clickOrHash('[data-section="ndc"], nav a[href*="differential"]', 'ndc'),
  quantification: () => clickOrHash('[data-section="quantification"], nav a[href*="quantif"]', 'quantification'),
  remote_access: () => clickOrHash('[data-section="remote"], nav a[href*="remote"]', 'remote'),
  report_export: () => clickOrHash('[data-section="report"], nav a[href*="report"]', 'report'),
  integration: () => clickOrHash('[data-section="integration"], nav a[href*="integrat"]', 'integration'),
  summary: () => clickOrHash('[data-section="summary"], nav a[href*="summary"]', 'summary'),
};

// ─── Action executors ───

async function executeAction(action) {
  await ensureBrowser();
  if (!page) throw new Error('Browser not initialized');

  switch (action.type) {
    case 'NAVIGATE': {
      const navFn = SECTION_MAP[action.section];
      if (navFn) {
        await navFn();
        await page.waitForTimeout(300); // let JS settle
      } else {
        throw new Error(`Unknown section: ${action.section}`);
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
        await page.click(action.selector, { timeout: CLICK_TIMEOUT_MS });
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

// proto-loader is configured with `enums: String`, so `type` arrives as the
// enum NAME ("HIGHLIGHT"), not a number. The old numeric-index mapping made
// every non-NAVIGATE action silently execute as NAVIGATE.
function resolveActionType(type) {
  if (typeof type === 'number') {
    return ['NAVIGATE', 'HIGHLIGHT', 'SCROLL', 'CLICK', 'WAIT', 'SCREENSHOT'][type] || null;
  }
  const name = String(type || '').toUpperCase();
  return VALID_ACTIONS.has(name) ? name : null;
}

async function handleExecuteAction(call, callback) {
  try {
    const { type, selector, section, direction, amount, wait_ms } = call.request;
    const actionType = resolveActionType(type);
    if (!actionType) {
      return callback(null, { success: false, message: `Unknown action type: ${type}` });
    }

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
      message: actionType.toLowerCase(),
      current_url: page?.url() || '',
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Action execution failed');
    callback(null, { success: false, message: err.message });
  }
}

async function handleInitialize(call, callback) {
  try {
    const { url, username, password } = call.request;

    await ensureBrowser();

    const targetUrl = url || BMA_URL;
    if (targetUrl) {
      await page.goto(targetUrl);

      if (username && password) {
        const filledUser = await page
          .fill('input[type="text"], input[name="username"], #username', username, { timeout: 3000 })
          .then(() => true).catch(() => false);
        const filledPass = await page
          .fill('input[type="password"], #password', password, { timeout: 3000 })
          .then(() => true).catch(() => false);
        const submitted = await page
          .click('button[type="submit"], input[type="submit"]', { timeout: 3000 })
          .then(() => true).catch(() => false);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        if (!(filledUser && filledPass && submitted)) {
          logger.warn({ filledUser, filledPass, submitted }, 'Login flow incomplete — check BMA selectors');
        }
      }
    }

    callback(null, { success: true, current_url: page?.url() || '' });
  } catch (err) {
    logger.error({ err: err.message }, 'Browser init failed');
    callback(null, { success: false, message: err.message });
  }
}

async function handleScreenshot(call, callback) {
  try {
    await ensureBrowser();
    const imageData = await page.screenshot({ type: 'png' });
    callback(null, { image_data: imageData, content_type: 'image/png' });
  } catch (err) {
    // A real error status — an empty buffer is indistinguishable from success
    callback({ code: grpc.status.INTERNAL, message: err.message });
  }
}

async function handleGetPageState(call, callback) {
  callback(null, {
    url: page?.url() || '',
    title: await page?.title().catch(() => '') || '',
    is_loaded: !!page && !page.isClosed(),
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

  // Pre-init the browser BEFORE binding gRPC so the first ExecuteAction
  // never races a not-yet-launched Chromium
  await ensureBrowser();
  await page.goto(BMA_URL).catch((err) => {
    logger.warn({ err: err.message }, 'Initial BMA navigation failed');
  });
  logger.info({ url: BMA_URL }, 'Browser pre-loaded BMA');

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
    if (err) {
      logger.error({ err }, `Failed to bind browser-controller gRPC on :${port}`);
      process.exit(1);
    }
    logger.info(`Browser controller gRPC listening on :${port}`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start browser-controller');
  process.exit(1);
});
