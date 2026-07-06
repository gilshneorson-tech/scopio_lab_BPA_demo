import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyBasicAuth from '@fastify/basic-auth';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_PROJECT_DIR = process.env.HOST_PROJECT_DIR || '/opt/scopio';
const ENV_FILE = `${HOST_PROJECT_DIR}/.env`;
const COMPOSE_FILE = `${HOST_PROJECT_DIR}/docker-compose.yml`;

const LAUNCHER_USER = process.env.LAUNCHER_USER || 'scopio';
const LAUNCHER_PASS = process.env.LAUNCHER_PASS || 'demo2026';
const PORT = parseInt(process.env.LAUNCHER_PORT || '8080');

const app = Fastify({ logger: true });

// ─── Docker Engine API via unix socket ───

function dockerAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function findContainer(service) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${service}`] }));
  const res = await dockerAPI('GET', `/containers/json?all=true&filters=${filters}`);
  return res.status === 200 && Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
}

// ─── Basic auth ───

await app.register(fastifyBasicAuth, {
  validate(username, password, _req, _reply, done) {
    if (username === LAUNCHER_USER && password === LAUNCHER_PASS) {
      done();
    } else {
      done(new Error('Unauthorized'));
    }
  },
  authenticate: { realm: 'Scopio Meeting Launcher' },
});

app.after(() => {
  app.addHook('onRequest', app.basicAuth);
});

await app.register(fastifyStatic, { root: resolve(__dirname, 'public') });

// ─── API ───

app.get('/api/status', async () => {
  try {
    const env = readFileSync(ENV_FILE, 'utf-8');
    const zoomMeetingId = env.match(/^ZOOM_MEETING_ID=(.*)$/m)?.[1] || '';
    const password = env.match(/^ZOOM_MEETING_PASSWORD=(.*)$/m)?.[1] || '';
    const meetUrl = env.match(/^MEET_URL=(.*)$/m)?.[1] || '';

    let botStatus = 'not running';
    let platform = '';
    let meetingId = '';

    // Check meet-bot first, then zoom-bot
    const meetContainer = await findContainer('meet-bot');
    if (meetContainer && meetContainer.State === 'running') {
      botStatus = 'running';
      platform = 'meet';
      meetingId = meetUrl;
    } else {
      const zoomContainer = await findContainer('zoom-bot');
      if (zoomContainer && zoomContainer.State === 'running') {
        botStatus = 'running';
        platform = 'zoom';
        meetingId = zoomMeetingId;
      } else if (zoomContainer) {
        botStatus = zoomContainer.State || 'unknown';
        platform = 'zoom';
        meetingId = zoomMeetingId;
      } else if (meetContainer) {
        botStatus = meetContainer.State || 'unknown';
        platform = 'meet';
        meetingId = meetUrl;
      }
    }

    return { meeting_id: meetingId, password, bot_status: botStatus, platform };
  } catch (err) {
    return { error: err.message };
  }
});

app.post('/api/join', async (req) => {
  let { meeting_id, password } = req.body || {};
  req.log.info({ raw_meeting_id: meeting_id, raw_password: password }, 'Join request received');
  if (!meeting_id) return { error: 'meeting_id is required' };

  const raw = meeting_id;

  // Detect platform from URL
  const isGoogleMeet = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(raw);
  const platform = isGoogleMeet ? 'meet' : 'zoom';
  req.log.info({ platform }, 'Detected platform');

  if (platform === 'meet') {
    // ─── Google Meet ───
    const meetMatch = raw.match(/meet\.google\.com\/([\w-]+)/i);
    const meetCode = meetMatch ? meetMatch[1] : raw.trim();
    const meetUrl = `https://meet.google.com/${meetCode}`;

    // Update .env with Meet URL
    let env = readFileSync(ENV_FILE, 'utf-8');
    // Add MEET_URL if it doesn't exist
    if (/^MEET_URL=/m.test(env)) {
      env = env.replace(/^MEET_URL=.*$/m, `MEET_URL=${meetUrl}`);
    } else {
      env += `\nMEET_URL=${meetUrl}\n`;
    }
    // Clear Zoom meeting ID so zoom-bot stays in standby
    env = env.replace(/^ZOOM_MEETING_ID=.*$/m, 'ZOOM_MEETING_ID=');
    writeFileSync(ENV_FILE, env);

    // Stop any running bot containers
    for (const service of ['meet-bot', 'zoom-bot']) {
      const existing = await findContainer(service);
      if (existing) {
        await dockerAPI('POST', `/containers/${existing.Id}/stop`);
        await dockerAPI('DELETE', `/containers/${existing.Id}?force=true`);
      }
    }

    // Update orchestrator's DEMO_BROWSER_GRPC_ADDR to point to meet-bot
    env = readFileSync(ENV_FILE, 'utf-8');
    if (/^DEMO_BROWSER_GRPC_ADDR=/m.test(env)) {
      env = env.replace(/^DEMO_BROWSER_GRPC_ADDR=.*$/m, 'DEMO_BROWSER_GRPC_ADDR=meet-bot:50057');
    }
    writeFileSync(ENV_FILE, env);

    try {
      const out = execSync(
        `docker compose -f ${COMPOSE_FILE} --project-directory ${HOST_PROJECT_DIR} --env-file ${ENV_FILE} up -d --no-build --no-deps meet-bot orchestrator 2>&1`,
        { encoding: 'utf-8', timeout: 60000 },
      );
      return { ok: true, meeting_id: meetCode, platform: 'meet', message: 'meet-bot joining Google Meet', detail: out.trim() };
    } catch (composeErr) {
      return { error: `Compose failed: ${composeErr.stderr || composeErr.stdout || composeErr.message}` };
    }
  }

  // ─── Zoom (existing logic) ───
  // Parse Zoom URLs: extract meeting ID and password from links like
  // https://zoom.us/j/12345?pwd=abc or https://scopiolabs.zoom.us/j/12345
  // Also handles pasted invite text: "https://...zoom.us/j/123 (Passcode: 456)"
  const urlMatch = meeting_id.match(/zoom\.us\/j\/(\d+)(?:[?&]pwd=([^&\s)]+))?/i);
  if (urlMatch) {
    meeting_id = urlMatch[1];
    if (!password && urlMatch[2]) password = urlMatch[2];
  }
  // Extract passcode from invite text like "(Passcode: 213283)"
  if (!password) {
    const passcodeMatch = (req.body.meeting_id || '').match(/\bPasscode:\s*(\S+)/i);
    if (passcodeMatch) password = passcodeMatch[1].replace(/[)]/g, '');
  }
  req.log.info({ parsed_id: meeting_id, parsed_pwd: password }, 'Parsed values');

  const cleanId = meeting_id.replace(/\D/g, '');
  req.log.info({ cleanId, password }, 'Final values');

  // Update .env on host (mounted volume)
  let env = readFileSync(ENV_FILE, 'utf-8');
  env = env.replace(/^ZOOM_MEETING_ID=.*$/m, `ZOOM_MEETING_ID=${cleanId}`);
  env = env.replace(/^ZOOM_MEETING_PASSWORD=.*$/m, `ZOOM_MEETING_PASSWORD=${password || ''}`);
  // Clear Meet URL so meet-bot stays in standby
  if (/^MEET_URL=/m.test(env)) {
    env = env.replace(/^MEET_URL=.*$/m, 'MEET_URL=');
  }
  writeFileSync(ENV_FILE, env);

  // Stop any running bot containers
  for (const service of ['zoom-bot', 'meet-bot']) {
    const existing = await findContainer(service);
    if (existing) {
      await dockerAPI('POST', `/containers/${existing.Id}/stop`);
      await dockerAPI('DELETE', `/containers/${existing.Id}?force=true`);
    }
  }

  // Update orchestrator's DEMO_BROWSER_GRPC_ADDR to point to zoom-bot
  env = readFileSync(ENV_FILE, 'utf-8');
  if (/^DEMO_BROWSER_GRPC_ADDR=/m.test(env)) {
    env = env.replace(/^DEMO_BROWSER_GRPC_ADDR=.*$/m, 'DEMO_BROWSER_GRPC_ADDR=zoom-bot:50057');
  }
  writeFileSync(ENV_FILE, env);

  // Recreate zoom-bot via docker compose
  try {
    const out = execSync(
      `docker compose -f ${COMPOSE_FILE} --project-directory ${HOST_PROJECT_DIR} --env-file ${ENV_FILE} up -d --no-build --no-deps zoom-bot orchestrator 2>&1`,
      { encoding: 'utf-8', timeout: 60000 },
    );
    return { ok: true, meeting_id: cleanId, platform: 'zoom', message: 'zoom-bot restarting with new meeting', detail: out.trim() };
  } catch (composeErr) {
    return { error: `Compose failed: ${composeErr.stderr || composeErr.stdout || composeErr.message}` };
  }
});

app.post('/api/stop', async () => {
  try {
    let stopped = false;
    for (const service of ['zoom-bot', 'meet-bot']) {
      const container = await findContainer(service);
      if (container && container.State === 'running') {
        await dockerAPI('POST', `/containers/${container.Id}/stop`);
        stopped = true;
      }
    }
    return { ok: true, message: stopped ? 'Bot stopped' : 'No bot running' };
  } catch (err) {
    return { error: `Failed to stop: ${err.message}` };
  }
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Meeting launcher running on http://0.0.0.0:${PORT}`);
