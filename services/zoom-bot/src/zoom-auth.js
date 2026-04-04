/**
 * Zoom Server-to-Server OAuth token generation.
 * Uses Account ID + Client ID + Client Secret to obtain an access token.
 */

import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const TOKEN_URL = 'https://zoom.us/oauth/token';

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get a valid Zoom access token, refreshing if needed.
 */
export async function getZoomToken() {
  const now = Date.now();

  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && tokenExpiresAt > now + 300000) {
    return cachedToken;
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Missing ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${TOKEN_URL}?grant_type=account_credentials&account_id=${accountId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom OAuth failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);

  logger.info({ expiresIn: data.expires_in }, 'Zoom OAuth token obtained');
  return cachedToken;
}
