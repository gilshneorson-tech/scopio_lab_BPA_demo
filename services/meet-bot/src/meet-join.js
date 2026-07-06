import pino from 'pino';
import { mkdirSync } from 'fs';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Save debug screenshots to shared volume for inspection
async function debugScreenshot(page, name) {
  try {
    mkdirSync('/tmp/meet-audio', { recursive: true });
    await page.screenshot({ path: `/tmp/meet-audio/debug-${name}.png`, fullPage: true });
    logger.info({ name }, 'Debug screenshot saved');
  } catch (e) {
    logger.warn({ name, err: e.message }, 'Could not save debug screenshot');
  }
}

/**
 * Sign into a Google account so we can join Workspace meetings.
 */
async function signIntoGoogle(page, email, password) {
  logger.info({ email }, 'Signing into Google account');

  await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Check if already signed in
  const url = page.url();
  if (url.includes('myaccount.google.com') || url.includes('/signedin')) {
    logger.info('Already signed into Google');
    return;
  }

  // Enter email
  try {
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ timeout: 10000 });
    await emailInput.fill(email);
    await page.locator('#identifierNext button, button:has-text("Next")').click();
    await page.waitForTimeout(3000);
    logger.info('Email entered');
  } catch (err) {
    logger.error({ err: err.message }, 'Could not enter email');
    return;
  }

  // Enter password — Google may show it immediately or after a transition
  try {
    const pwdInput = page.locator('input[type="password"]');
    await pwdInput.waitFor({ timeout: 15000 });
    await pwdInput.fill(password);
    await page.locator('#passwordNext button, button:has-text("Next")').click();
    await page.waitForTimeout(5000);
    logger.info('Password entered');
  } catch (err) {
    // Password field didn't appear — Google may have shown CAPTCHA, 2FA, or recovery prompt
    await debugScreenshot(page, 'signin-password-failed');
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
    logger.warn({ err: err.message, bodyText }, 'Could not enter password — continuing without sign-in');
    // Don't return — allow guest join as fallback
  }

  // Check if 2FA is required
  const afterUrl = page.url();
  if (afterUrl.includes('challenge') || afterUrl.includes('signin/v2')) {
    logger.warn('2FA challenge detected — bot cannot proceed. Use a Google account without 2FA or an App Password.');
    // Wait a bit in case it's a simple "confirm on phone" prompt
    await page.waitForTimeout(30000);
  }

  // Verify sign-in succeeded
  const finalUrl = page.url();
  if (finalUrl.includes('myaccount') || !finalUrl.includes('signin')) {
    logger.info('Google sign-in successful');
  } else {
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
    logger.warn({ finalUrl, bodyText }, 'Sign-in may not have completed');
  }
}

/**
 * Join a Google Meet meeting using Playwright.
 *
 * @param {import('playwright').Page} page — Chromium page (should already be launched)
 * @param {string} meetUrl — Full meet URL (e.g. https://meet.google.com/abc-defg-hij)
 * @param {string} botName — Display name for the bot
 * @returns {Promise<boolean>} true if joined successfully
 */
export async function joinGoogleMeet(page, meetUrl, botName = 'Scopio Demo Agent') {
  logger.info({ meetUrl, botName }, 'Joining Google Meet');

  // Google sign-in is disabled — automated login always triggers CAPTCHA.
  // Guest join works when meeting has "Quick access" enabled.
  // To enable sign-in: manually sign into Google in the persistent Chrome profile.

  // Navigate to the meeting URL — may need multiple attempts due to rate limiting
  for (let loadAttempt = 0; loadAttempt < 5; loadAttempt++) {
    await page.goto(meetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const bodyCheck = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
    if (!bodyCheck.includes("can't join")) break;

    const delay = (loadAttempt + 1) * 10000; // 10s, 20s, 30s, 40s
    logger.warn({ loadAttempt, delayMs: delay }, 'Got "can\'t join" — waiting and retrying');
    await page.waitForTimeout(delay);
  }
  await debugScreenshot(page, '01-meet-landing');

  // Dismiss "Got it" consent / info banners
  try {
    const gotIt = page.locator('button:has-text("Got it")');
    if (await gotIt.isVisible({ timeout: 2000 })) {
      await gotIt.click();
      logger.info('Dismissed "Got it" banner');
      await page.waitForTimeout(500);
    }
  } catch {
    // No banner — continue
  }

  // Fill in the display name (guest join)
  // The name input shows as "What's your name?" with a 0/60 counter
  try {
    // Try multiple selector strategies
    let nameInput = page.locator('input[aria-label="Your name"]');
    if (!(await nameInput.isVisible({ timeout: 2000 }).catch(() => false))) {
      // Fallback: find input near "What's your name?" text
      nameInput = page.locator('input[type="text"]').first();
    }

    if (await nameInput.isVisible({ timeout: 3000 })) {
      await nameInput.click();
      await nameInput.fill('');
      await nameInput.fill(botName);
      logger.info({ botName }, 'Name filled');
    } else {
      logger.warn('Name input not visible');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not fill name — may require sign-in');
  }

  await page.waitForTimeout(1000);
  await debugScreenshot(page, '02-pre-join');

  // Log all clickable elements on the pre-join page for debugging
  const preJoinElements = await page.evaluate(() => {
    const elems = document.querySelectorAll('button, [role="button"], [data-tooltip]');
    return Array.from(elems).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 80),
      aria: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
    })).filter(x => x.text || x.aria);
  }).catch(() => []);
  logger.info({ preJoinElements }, 'Pre-join page elements');

  // Click "Join now" or "Ask to join"
  try {
    // Try "Join now" first (open meetings), then "Ask to join" (restricted meetings)
    let joinBtn = page.locator('button:has-text("Join now")');
    if (!(await joinBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      joinBtn = page.locator('button:has-text("Ask to join")');
    }

    if (await joinBtn.isVisible({ timeout: 5000 })) {
      await joinBtn.click();
      logger.info('Join button clicked');
    } else {
      // Last resort: find by aria-label
      const fallback = page.locator('[aria-label*="join" i]').first();
      await fallback.click({ timeout: 5000 });
      logger.info('Join button clicked (fallback selector)');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Could not find join button');

    // Debug: log what's on the page
    try {
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      logger.error({ bodyText }, 'Page content at time of failure');
    } catch { /* ignore */ }

    return false;
  }

  await debugScreenshot(page, '03-after-join-click');

  // Wait for meeting UI to appear — try multiple indicators
  logger.info('Waiting for meeting to load...');

  // Poll for meeting indicators (leave button, toolbar, etc.)
  const meetingReady = await Promise.race([
    page.waitForSelector('[aria-label="Leave call"]', { timeout: 30000 }).then(() => 'leave-btn'),
    page.waitForSelector('[aria-label*="end call" i]', { timeout: 30000 }).then(() => 'end-call'),
    page.waitForSelector('button[aria-label="Turn off microphone"]', { timeout: 30000 }).then(() => 'mic-btn'),
    page.waitForSelector('[aria-label="More options"]', { timeout: 30000 }).then(() => 'more-opts'),
    // Fallback: just wait 8 seconds — if Join was clicked, we're likely in
    new Promise(resolve => setTimeout(() => resolve('timeout'), 8000)),
  ]).catch(() => 'error');

  logger.info({ indicator: meetingReady }, 'Meeting join detected');

  // Verify we're not on an error page
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
  if (bodyText.includes("can't join") || bodyText.includes('Return to home')) {
    logger.error({ bodyText }, 'Not in meeting — blocked');
    return false;
  }

  logger.info('Successfully joined Google Meet');
  return true;
}

/**
 * Leave the current Google Meet.
 */
export async function leaveGoogleMeet(page) {
  try {
    const leaveBtn = page.locator('[aria-label="Leave call"], [aria-label*="end call" i]');
    await leaveBtn.click({ timeout: 5000 });
    logger.info('Left Google Meet');
  } catch {
    logger.warn('Could not find leave button — closing page');
  }
}
