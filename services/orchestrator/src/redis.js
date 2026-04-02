import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const SESSION_TTL = 7200; // 2 hours

export async function setSessionState(callId, state) {
  await redis.set(`session:${callId}:state`, state, 'EX', SESSION_TTL);
}

export async function setSessionStep(callId, step) {
  await redis.set(`session:${callId}:step`, String(step), 'EX', SESSION_TTL);
}

export async function setSessionStarted(callId, timestamp) {
  await redis.set(`session:${callId}:started_at`, String(timestamp), 'EX', SESSION_TTL);
}

export async function setProspectName(callId, name) {
  if (name) {
    await redis.set(`session:${callId}:prospect_name`, name, 'EX', SESSION_TTL);
  }
}

export async function appendHistory(callId, entry) {
  const key = `session:${callId}:history`;
  await redis.rpush(key, JSON.stringify(entry));
  await redis.ltrim(key, -20, -1); // keep last 20 exchanges
  await redis.expire(key, SESSION_TTL);
}

export async function getHistory(callId, count = 5) {
  const items = await redis.lrange(`session:${callId}:history`, -count, -1);
  return items.map((item) => JSON.parse(item));
}

export async function getSessionInfo(callId) {
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
}

export async function clearSession(callId) {
  const keys = await redis.keys(`session:${callId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export { redis };
