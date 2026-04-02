import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null; // stop retrying
    return Math.min(times * 200, 2000);
  },
});

let redisAvailable = true;

redis.on('error', (err) => {
  if (redisAvailable) {
    console.error('Redis connection error (degraded mode):', err.message);
    redisAvailable = false;
  }
});

redis.on('connect', () => {
  redisAvailable = true;
});

const SESSION_TTL = 7200; // 2 hours

export async function setSessionState(callId, state) {
  try {
    await redis.set(`session:${callId}:state`, state, 'EX', SESSION_TTL);
  } catch { /* degraded mode */ }
}

export async function setSessionStep(callId, step) {
  try {
    await redis.set(`session:${callId}:step`, String(step), 'EX', SESSION_TTL);
  } catch { /* degraded mode */ }
}

export async function setSessionStarted(callId, timestamp) {
  try {
    await redis.set(`session:${callId}:started_at`, String(timestamp), 'EX', SESSION_TTL);
  } catch { /* degraded mode */ }
}

export async function setProspectName(callId, name) {
  try {
    if (name) {
      await redis.set(`session:${callId}:prospect_name`, name, 'EX', SESSION_TTL);
    }
  } catch { /* degraded mode */ }
}

export async function appendHistory(callId, entry) {
  try {
    const key = `session:${callId}:history`;
    await redis.rpush(key, JSON.stringify(entry));
    await redis.ltrim(key, -20, -1);
    await redis.expire(key, SESSION_TTL);
  } catch { /* degraded mode */ }
}

export async function getHistory(callId, count = 5) {
  try {
    const items = await redis.lrange(`session:${callId}:history`, -count, -1);
    return items.map((item) => JSON.parse(item));
  } catch {
    return [];
  }
}

export async function getSessionInfo(callId) {
  try {
    const [state, step, startedAt, prospectName] = await redis.mget(
      `session:${callId}:state`,
      `session:${callId}:step`,
      `session:${callId}:started_at`,
      `session:${callId}:prospect_name`,
    );
    return {
      state: state || 'unknown',
      step: parseInt(step || '0', 10),
      startedAt: parseInt(startedAt || '0', 10),
      prospectName: prospectName || '',
    };
  } catch {
    return { state: 'unknown', step: 0, startedAt: 0, prospectName: '' };
  }
}

export async function clearSession(callId) {
  try {
    const keys = await redis.keys(`session:${callId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch { /* degraded mode */ }
}

export { redis };
