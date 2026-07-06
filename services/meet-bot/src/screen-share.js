import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Start screen sharing in Google Meet.
 *
 * Strategy: Share "A Chrome tab" containing the demo page.
 * The Chromium flag --auto-select-tab-capture-source-by-title=Scopio
 * auto-selects the correct tab in the native picker.
 *
 * @param {import('playwright').Page} page — The Google Meet page (must be in-meeting)
 */
export async function startScreenShare(page) {
  logger.info('Starting screen share in Google Meet');

  await page.waitForTimeout(2000);

  try {
    // Move mouse to bottom-center to trigger Meet toolbar (it auto-hides)
    const viewport = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(viewport.width / 2, viewport.height - 50);
    await page.waitForTimeout(1500);

    // Step 1: Click the "Share screen" button in the meeting toolbar
    // In-meeting toolbar uses aria-label="Share screen", NOT "Present"
    const shareSelectors = [
      'button[aria-label="Share screen"]',
      'button[aria-label*="Share screen" i]',
      'button[aria-label*="share screen" i]',
      'button:has-text("Present"):not(:has-text("Stop"))',
      'button[aria-label*="Present now" i]',
      '[data-tooltip*="Present" i]',
    ];

    let clicked = false;
    for (const sel of shareSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          clicked = true;
          logger.info({ selector: sel }, 'Clicked Share screen button');
          break;
        }
      } catch {
        continue;
      }
    }

    if (!clicked) {
      // Debug: log all interactive elements
      const allClickables = await page.evaluate(() => {
        const elems = document.querySelectorAll('button, [role="button"], [data-tooltip]');
        return Array.from(elems).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 60),
          aria: el.getAttribute('aria-label'),
        })).filter(x => x.text || x.aria);
      }).catch(() => []);
      logger.warn({ allClickables }, 'Could not find Share screen button');
      return false;
    }

    await page.waitForTimeout(2000);

    // Step 2: Select "A Chrome tab" in Meet's sharing dialog
    // This avoids the system screen picker that fails in containers.
    // The native tab picker is then handled by --auto-select-tab-capture-source-by-title
    const tabSelectors = [
      'button:has-text("A Chrome tab")',
      'li:has-text("A Chrome tab")',
      '[role="tab"]:has-text("A Chrome tab")',
      'button:has-text("A tab")',
      'li:has-text("A tab")',
      '[role="tab"]:has-text("tab")',
      // Meet may show it as a div/span option
      'div[role="option"]:has-text("tab")',
      'span:has-text("A Chrome tab")',
    ];

    let tabSelected = false;
    for (const sel of tabSelectors) {
      try {
        const opt = page.locator(sel).first();
        if (await opt.isVisible({ timeout: 2000 })) {
          await opt.click();
          tabSelected = true;
          logger.info({ selector: sel }, 'Selected "A Chrome tab" option');
          break;
        }
      } catch {
        continue;
      }
    }

    if (!tabSelected) {
      // Maybe Meet went straight to sharing (no dialog), or try "Entire screen" fallback
      logger.warn('Could not find "A Chrome tab" option, trying Entire screen');

      // Log dialog contents for debugging
      const dialogContent = await page.evaluate(() => {
        const items = document.querySelectorAll('[role="dialog"] *, [role="tab"], [role="option"], [role="menuitem"]');
        return Array.from(items).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 80),
          role: el.getAttribute('role'),
          aria: el.getAttribute('aria-label'),
        })).filter(x => x.text);
      }).catch(() => []);
      logger.info({ dialogContent: dialogContent.slice(0, 20) }, 'Share dialog content');

      const screenSelectors = [
        'button:has-text("Entire screen")',
        'button:has-text("Your entire screen")',
        '[role="tab"]:has-text("entire screen")',
        'li:has-text("Entire screen")',
      ];

      for (const sel of screenSelectors) {
        try {
          const opt = page.locator(sel).first();
          if (await opt.isVisible({ timeout: 1500 })) {
            await opt.click();
            logger.info({ selector: sel }, 'Selected Entire screen fallback');
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // Step 3: Wait for sharing to start (auto-select handles the native picker)
    logger.info('Waiting for screen share to activate...');
    await page.waitForTimeout(5000);

    // Check for error dialog and dismiss
    try {
      const errorDialog = page.locator('text="Can\'t share your screen"');
      if (await errorDialog.isVisible({ timeout: 2000 })) {
        logger.warn('Screen share error dialog — dismissing');
        await page.locator('button:has-text("OK"), button:has-text("Got it")').click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return false;
      }
    } catch { /* no error */ }

    // Verify sharing is active
    try {
      const stopBtn = page.locator(
        'button[aria-label*="Stop" i][aria-label*="present" i], button[aria-label*="Stop" i][aria-label*="shar" i], button:has-text("Stop presenting"), button:has-text("Stop sharing")'
      );
      if (await stopBtn.isVisible({ timeout: 5000 })) {
        logger.info('Screen share confirmed active');
        return true;
      }
    } catch { /* ignore */ }

    // Also check if the share button changed state (indicates sharing started)
    try {
      const activeShare = page.locator('button[aria-label*="Stop sharing" i], button[aria-label*="stop presenting" i]');
      if (await activeShare.isVisible({ timeout: 2000 })) {
        logger.info('Screen share active (stop button found)');
        return true;
      }
    } catch { /* ignore */ }

    logger.warn('Screen share may not be active — continuing anyway');
    return false;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to start screen share');
    return false;
  }
}

/**
 * Stop screen sharing.
 */
export async function stopScreenShare(page) {
  try {
    const stopBtn = page.locator(
      'button[aria-label*="Stop" i][aria-label*="present" i], button[aria-label*="Stop" i][aria-label*="shar" i], button:has-text("Stop presenting"), button:has-text("Stop sharing")'
    );
    await stopBtn.click({ timeout: 5000 });
    logger.info('Screen share stopped');
  } catch {
    logger.warn('Could not stop screen share');
  }
}
